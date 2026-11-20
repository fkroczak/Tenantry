/**
 * Tenantry – Service Worker (Manifest V3).
 *
 * Alle Listener werden synchron auf Top-Level registriert (Pflicht in MV3,
 * damit Events den schlafenden Worker wieder aufwecken). Jeder Handler wartet
 * auf `ready`, bis der Zustand aus chrome.storage geladen ist.
 */
import { parseSetCookie } from '../shared/cookies';
import { toTuple } from '../shared/payload';
import { KNOWN_APP_ORIGINS, SCOPE_MATCH_PATTERNS, urlInScope } from '../shared/scope';
import {
  COLOR_HEX,
  type ContentRequest,
  type CookiePush,
  type HelloResponse,
  type PopupRequest,
  type PopupState,
  type Result,
} from '../shared/types';
import { extractSetCookies, onNativeCookieChanged, parseResponseCookies, scrubNative } from './capture';
import { exportBackup, importBackup, lastBackupAt } from './backup';
import { diag, diagClear, diagExport, diagStart, diagStatus, diagStop, registerDiagListeners } from './diag';
import { hasRules, initDnr, syncTabs, whenSynced } from './dnr';
import { ensureGrouped, enforceGroupLook, recoverFromGroups, refreshGroups, ungroup } from './groups';
import { applyCookies, deleteJar, flush, listCookies, loadJars, purgeExpired } from './jar';
import {
  containerById,
  containerOfTab,
  isValidColor,
  loadState,
  markBooted,
  saveContainers,
  saveGroups,
  saveTabs,
  state,
  tabsOf,
  validateName,
} from './state';
import { redactUrl, summarizeSetCookie } from './diagFormat';
import { missingCookies, RetryLimiter } from './stale';
import { checkForUpdate, getUpdateInfo, reloadIfUpdatedOnDisk, showUpdateBadge, versionOnDisk } from './update';
import { log, randomId, warn } from './util';

const EXTERNAL_IDP_ORIGINS = ['https://*/*'];

// ---------------------------------------------------------------------------
// Initialisierung
// ---------------------------------------------------------------------------

const ready: Promise<void> = boot().catch((e) => {
  warn('Start fehlgeschlagen', e);
});

registerDiagListeners(ready);

async function boot(): Promise<void> {
  const { fresh } = await loadState();
  await loadJars(state.containers.map((c) => c.id));

  // Tab-Zuordnungen auf existierende Tabs reduzieren.
  const existing = new Set((await chrome.tabs.query({})).map((t) => t.id));
  for (const tabId of [...state.tabs.keys()]) if (!existing.has(tabId)) state.tabs.delete(tabId);
  for (const [tabId, cid] of [...state.tabs]) if (!containerById(cid)) state.tabs.delete(tabId);

  await initDnr(fresh);

  if (fresh) {
    // Browser-Neustart oder Erweiterung neu geladen: Regeln sind weg,
    // Zuordnung über die Tab-Gruppen wiederherstellen.
    const recovered = await recoverFromGroups();
    for (const [tabId, cid] of recovered) state.tabs.set(tabId, cid);
    await saveTabs();
    await syncTabs(state.tabs.keys());
    await markBooted();
    for (const tabId of recovered.keys()) {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      // Bereits geladene Seiten wurden ohne Container-Cookies geladen -> neu laden.
      if (tab && !tab.discarded && urlInScope(tab.url)) void chrome.tabs.reload(tabId);
    }
    log('Neustart: Tabs aus Gruppen wiederhergestellt', recovered.size);
  } else {
    const missing = [...state.tabs.keys()].filter((t) => !hasRules(t));
    if (missing.length) await syncTabs(missing);
  }
  await saveTabs();
  for (const tabId of state.tabs.keys()) updateBadge(tabId);
  void chrome.alarms.create('purge', { periodInMinutes: 1 });
  // Update: GitHub alle 6 h fragen, Ordner jede Minute auf neue Dateien prüfen.
  void chrome.alarms.create('update-check', { periodInMinutes: 60, delayInMinutes: 1 });
  void chrome.alarms.create('update-disk', { periodInMinutes: 1 });
  void showUpdateBadge();
}

// ---------------------------------------------------------------------------
// Container <-> Tab
// ---------------------------------------------------------------------------

async function assignTab(tabId: number, cid: string | null, opts: { reload?: boolean } = {}): Promise<void> {
  if (cid) freshTabs.delete(tabId);
  if (cid) state.tabs.set(tabId, cid);
  else state.tabs.delete(tabId);
  await saveTabs();
  await syncTabs([tabId]);
  updateBadge(tabId);
  if (cid) void ensureGrouped(tabId);
  diag('tab:assign', { tab: tabId, reload: !!opts.reload });
  if (opts.reload) await chrome.tabs.reload(tabId).catch(() => undefined);
}

function updateBadge(tabId: number): void {
  const c = containerOfTab(tabId);
  const text = c ? c.name.replace(/[^\p{L}\p{N}]/gu, '').slice(0, 2).toUpperCase() || '•' : '';
  // null = Standard-Badge (z. B. „↑“ für ein verfügbares Update) anzeigen.
  chrome.action.setBadgeText({ tabId, text: c ? text : (null as unknown as string) }).catch(() => undefined);
  if (c) chrome.action.setBadgeBackgroundColor({ tabId, color: COLOR_HEX[c.color] }).catch(() => undefined);
  chrome.action.setTitle({ tabId, title: c ? `Tenantry – Container: ${c.name}` : 'Tenantry' }).catch(() => undefined);
}

/** Cookies eines Containers haben sich geändert: Regeln + offene Seiten aktualisieren. */
async function onJarChanged(cid: string): Promise<void> {
  const tabs = tabsOf(cid);
  await syncTabs(tabs);
  const msg: CookiePush = { type: 'bg:cookies', cid, cookies: jsCookies(cid) };
  for (const tabId of tabs) chrome.tabs.sendMessage(tabId, msg).catch(() => undefined);
}

/**
 * Nach einer Wiederherstellung: offene Tab-Gruppen mit dem Namen eines
 * Containers wieder diesem Container zuordnen und neu laden.
 */
async function adoptOpenGroups(): Promise<void> {
  const recovered = await recoverFromGroups();
  const changed: number[] = [];
  for (const [tabId, cid] of recovered) {
    if (state.tabs.get(tabId) === cid) continue;
    state.tabs.set(tabId, cid);
    changed.push(tabId);
  }
  if (!changed.length) return;
  await saveTabs();
  await syncTabs(changed);
  for (const tabId of changed) {
    updateBadge(tabId);
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab && !tab.discarded && urlInScope(tab.url)) void chrome.tabs.reload(tabId);
  }
}

function jsCookies(cid: string) {
  return listCookies(cid)
    .filter((c) => !c.httpOnly)
    .map(toTuple);
}

/** Neuen Tab im Container öffnen. Die Regeln stehen, BEVOR navigiert wird. */
async function openInContainer(cid: string, url: string, base?: chrome.tabs.Tab): Promise<number> {
  const tab = await chrome.tabs.create({
    url: 'about:blank',
    active: true,
    ...(base ? { windowId: base.windowId, index: base.index + 1 } : {}),
  });
  if (tab.id === undefined) throw new Error('Tab konnte nicht erstellt werden.');
  await assignTab(tab.id, cid);
  await chrome.tabs.update(tab.id, { url });
  return tab.id;
}

// ---------------------------------------------------------------------------
// Vererbung: neue Tabs / Popups / window.open
// ---------------------------------------------------------------------------

/**
 * Neue Tabs ohne Container (Strg+T, „+“, Lesezeichen, Omnibox) mit
 * Erstellzeitpunkt. Setzt Chrome so einen Tab von selbst in eine
 * Container-Gruppe (z. B. Strg+T neben einem gruppierten Tab), wird er wieder
 * herausgenommen statt dem Container zugeordnet. Container-Tabs entstehen nur
 * über das Popup, über Links/Popups einer Container-Seite oder per Drag & Drop.
 */
const freshTabs = new Map<number, number>();
const FRESH_MS = 2000;

function isFresh(tabId: number, now = Date.now()): boolean {
  const t = freshTabs.get(tabId);
  return t !== undefined && now - t < FRESH_MS;
}

chrome.tabs.onCreated.addListener((tab) => {
  const createdAt = Date.now();
  void ready.then(async () => {
    if (tab.id === undefined || state.tabs.has(tab.id)) return;
    const cid = tab.openerTabId !== undefined ? state.tabs.get(tab.openerTabId) : undefined;
    // Nur Tabs, die eine Container-Seite per Link öffnet (Ziel ist eine
    // M365-Adresse), erben den Container. Leere Tabs (chrome://newtab) nicht.
    if (cid && urlInScope(tab.pendingUrl ?? tab.url)) {
      await assignTab(tab.id, cid);
      return;
    }
    freshTabs.set(tab.id, createdAt);
    if (tab.groupId !== undefined && tab.groupId !== -1 && state.groups.has(tab.groupId)) await ungroup([tab.id]);
  });
});

chrome.webNavigation.onCreatedNavigationTarget.addListener((d) => {
  void ready.then(async () => {
    // Link/window.open aus einer Container-Seite: Container erben.
    if (state.tabs.has(d.tabId)) return;
    const cid = state.tabs.get(d.sourceTabId);
    if (cid) await assignTab(d.tabId, cid);
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  staleRetry.forget(tabId);
  freshTabs.delete(tabId);
  void ready.then(async () => {
    if (!state.tabs.has(tabId)) return;
    state.tabs.delete(tabId);
    await saveTabs();
    await syncTabs([tabId]);
  });
});

chrome.tabs.onReplaced.addListener((added, removed) => {
  void ready.then(async () => {
    const cid = state.tabs.get(removed);
    if (!cid) return;
    state.tabs.delete(removed);
    await syncTabs([removed]);
    await assignTab(added, cid);
  });
});

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading') updateBadge(tabId);
  if (info.groupId === undefined) return;
  const groupId = info.groupId;
  void ready.then(async () => {
    const current = state.tabs.get(tabId) ?? null;
    const target = groupId === -1 ? null : (state.groups.get(groupId) ?? null);
    if (target && !current && isFresh(tabId)) {
      // Chrome hat einen neuen, leeren Tab selbst in die Gruppe gesetzt:
      // wieder herausnehmen, kein Container.
      await ungroup([tabId]);
      return;
    }
    if (target && target !== current) {
      // Benutzer hat den Tab in die Gruppe eines anderen Containers gezogen.
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      await assignTab(tabId, target, { reload: !!tab && /^https?:/.test(tab.url ?? '') });
      return;
    }
    if (current && !target) {
      // Aus der Gruppe entfernt / in anderes Fenster verschoben: Ein Tab
      // bleibt immer in seinem Container -> wieder einsortieren.
      setTimeout(() => void ensureGrouped(tabId), 400);
    }
  });
});

chrome.tabGroups.onUpdated.addListener((g) => void ready.then(() => enforceGroupLook(g)));
chrome.tabGroups.onRemoved.addListener((g) => {
  void ready.then(async () => {
    if (state.groups.delete(g.id)) await saveGroups();
  });
});

// ---------------------------------------------------------------------------
// Cookies
// ---------------------------------------------------------------------------

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0) return undefined;
    const headers = extractSetCookies(details);
    if (!headers.length) return undefined;
    void ready.then(async () => {
      const cid = state.tabs.get(details.tabId);
      if (!cid) return;
      const cookies = parseResponseCookies(details, headers);
      if (!cookies.length) return;
      scrubNative(cookies, new URL(details.url).hostname);
      const changed = applyCookies(cid, cookies);
      if (changed) await onJarChanged(cid);
      diag('jar:fromResponse', { tab: details.tabId, req: details.requestId, names: cookies.map((c) => c.name), changed, rulesSyncedAfterMs: Math.round(Date.now() - details.timeStamp) });
    });
    return undefined;
  },
  { urls: [...SCOPE_MATCH_PATTERNS] },
  ['responseHeaders', 'extraHeaders'],
);

/**
 * Navigation mit veralteten Cookies wiederholen (siehe stale.ts). Typischer
 * Fall: SharePoint setzt FedAuth auf einem 302 und leitet sofort weiter,
 * bevor die DNR-Regeln das neue Cookie enthalten.
 */
const staleRetry = new RetryLimiter();

chrome.webRequest.onSendHeaders.addListener(
  (details) => {
    if (details.tabId < 0 || details.frameId !== 0 || details.method !== 'GET') return;
    const sent = details.requestHeaders?.find((h) => h.name.toLowerCase() === 'cookie')?.value;
    const sentAt = details.timeStamp;
    void ready.then(async () => {
      const cid = state.tabs.get(details.tabId);
      if (!cid) return;
      // Läuft nach den Set-Cookie-Handlern vorheriger Antworten (gleiche Reihenfolge an `ready`).
      const missing = missingCookies(listCookies(cid), details.url, sent, sentAt);
      if (!missing.length) return;
      await whenSynced();
      if (state.tabs.get(details.tabId) !== cid) return;
      if (!staleRetry.allow(details.tabId, Date.now())) {
        warn('Navigation mit veralteten Cookies, Wiederholungslimit erreicht', details.url, missing);
        diag('stale:limit', { tab: details.tabId, req: details.requestId, url: redactUrl(details.url), missing });
        return;
      }
      log('Navigation mit veralteten Cookies wird wiederholt', details.url, missing);
      diag('stale:retry', { tab: details.tabId, req: details.requestId, url: redactUrl(details.url), missing });
      await chrome.tabs.update(details.tabId, { url: details.url }).catch(() => undefined);
    });
  },
  { urls: [...SCOPE_MATCH_PATTERNS], types: ['main_frame'] },
  ['requestHeaders', 'extraHeaders'],
);

chrome.cookies.onChanged.addListener(onNativeCookieChanged);

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'update-check') void checkForUpdate().catch((e) => warn('Update-Prüfung fehlgeschlagen', e));
  if (a.name === 'update-disk') void ready.then(() => reloadIfUpdatedOnDisk(flush));
  if (a.name !== 'purge') return;
  void ready.then(async () => {
    for (const cid of purgeExpired()) await onJarChanged(cid);
  });
});

// ---------------------------------------------------------------------------
// Nachrichten
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg: { type?: string }, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || typeof msg?.type !== 'string') return false;
  // Popup (oder eine als Tab geöffnete Erweiterungsseite). Content-Scripts haben
  // hier die URL der Webseite und können sich nicht als Erweiterungsseite ausgeben.
  const isExtensionPage = (sender.url ?? '').startsWith(chrome.runtime.getURL(''));

  let handler: Promise<unknown> | null = null;
  if (msg.type.startsWith('content:') && sender.tab?.id !== undefined && !isExtensionPage) {
    handler = ready.then(() => handleContent(msg as ContentRequest, sender));
  } else if (isExtensionPage && !msg.type.startsWith('content:')) {
    handler = ready.then(() => handlePopup(msg as PopupRequest)).then(
      (data): Result<unknown> => ({ ok: true, data }),
      (e: unknown): Result<unknown> => ({ ok: false, error: e instanceof Error ? e.message : String(e) }),
    );
  }
  if (!handler) return false;
  handler.then(sendResponse, () => sendResponse(null));
  return true; // asynchrone Antwort
});

async function handleContent(msg: ContentRequest, sender: chrome.runtime.MessageSender): Promise<unknown> {
  const tabId = sender.tab!.id!;
  const cid = state.tabs.get(tabId) ?? null;
  switch (msg.type) {
    case 'content:hello': {
      const res: HelloResponse = { cid, cookies: cid ? jsCookies(cid) : [] };
      if (cid) diag('content:hello', { tab: tabId, frame: sender.frameId, url: redactUrl(sender.url) });
      return res;
    }
    case 'content:setCookie': {
      if (!cid || typeof msg.cookie !== 'string' || !urlInScope(sender.url)) return false;
      const parsed = parseSetCookie(msg.cookie, new URL(sender.url!), Date.now(), { fromScript: true });
      if (!parsed) {
        diag('content:setCookie', { tab: tabId, url: redactUrl(sender.url), cookie: summarizeSetCookie(msg.cookie), rejected: true });
        return false;
      }
      const t0 = Date.now();
      const changed = applyCookies(cid, [parsed], { fromScript: true });
      if (changed) await onJarChanged(cid);
      diag('content:setCookie', { tab: tabId, url: redactUrl(sender.url), cookie: summarizeSetCookie(msg.cookie), changed, rulesSyncedAfterMs: Date.now() - t0 }, t0);
      return true;
    }
  }
  return null;
}

async function handlePopup(msg: PopupRequest): Promise<unknown> {
  switch (msg.type) {
    case 'popup:state': {
      const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      const res: PopupState = {
        containers: state.containers.map((c) => ({ ...c, tabCount: tabsOf(c.id).length })),
        current:
          active?.id !== undefined
            ? { tabId: active.id, containerId: state.tabs.get(active.id) ?? null, url: active.url ?? null }
            : null,
        externalIdpEnabled: await chrome.permissions.contains({ origins: EXTERNAL_IDP_ORIGINS }),
      };
      return res;
    }
    case 'container:create': {
      const name = validateName(msg.name);
      if (!isValidColor(msg.color)) throw new Error('Ungültige Farbe.');
      const c = { id: randomId('c'), name, color: msg.color, createdAt: Date.now() };
      state.containers.push(c);
      await saveContainers();
      return c;
    }
    case 'container:update': {
      const c = containerById(msg.id);
      if (!c) throw new Error('Container nicht gefunden.');
      if (msg.name !== undefined) c.name = validateName(msg.name, c.id);
      if (msg.color !== undefined) {
        if (!isValidColor(msg.color)) throw new Error('Ungültige Farbe.');
        c.color = msg.color;
      }
      if (msg.favorite !== undefined) c.favorite = !!msg.favorite;
      await saveContainers();
      if (msg.name === undefined && msg.color === undefined) return c;
      await refreshGroups(c.id);
      for (const t of tabsOf(c.id)) updateBadge(t);
      return c;
    }
    case 'container:delete': {
      const c = containerById(msg.id);
      if (!c) throw new Error('Container nicht gefunden.');
      const tabs = tabsOf(c.id);
      for (const t of tabs) state.tabs.delete(t);
      await saveTabs();
      await syncTabs(tabs);
      await ungroup(tabs);
      for (const [gid, cid] of state.groups) if (cid === c.id) state.groups.delete(gid);
      await saveGroups();
      state.containers = state.containers.filter((x) => x.id !== c.id);
      await saveContainers();
      await deleteJar(c.id);
      for (const t of tabs) {
        updateBadge(t);
        void chrome.tabs.reload(t).catch(() => undefined);
      }
      return true;
    }
    case 'container:openTab': {
      if (!containerById(msg.id)) throw new Error('Container nicht gefunden.');
      if (!/^https:\/\//.test(msg.url)) throw new Error('Nur https-URLs sind erlaubt.');
      return openInContainer(msg.id, msg.url);
    }
    case 'tab:reopenIn': {
      if (!containerById(msg.id)) throw new Error('Container nicht gefunden.');
      const tab = await chrome.tabs.get(msg.tabId);
      const url = tab.url && /^https?:\/\//.test(tab.url) ? tab.url : 'https://www.office.com/';
      return openInContainer(msg.id, url, tab);
    }
    case 'diag:status':
      return diagStatus();
    case 'diag:start':
      return diagStart();
    case 'diag:stop':
      return diagStop();
    case 'diag:clear':
      return diagClear();
    case 'diag:export':
      return diagExport();
    case 'update:status': {
      // Popup geöffnet: Ordner prüfen und (gedrosselt) GitHub fragen.
      if (await reloadIfUpdatedOnDisk(flush)) return getUpdateInfo();
      void checkForUpdate().catch(() => undefined);
      return getUpdateInfo();
    }
    case 'update:check':
      return checkForUpdate(true);
    case 'update:reload': {
      if (!(await reloadIfUpdatedOnDisk(flush))) {
        const disk = await versionOnDisk();
        throw new Error(`Im Erweiterungsordner liegt noch Version ${disk ?? '?'}. Zuerst Tenantry-Update.cmd ausführen.`);
      }
      return true;
    }
    case 'backup:status':
      return lastBackupAt();
    case 'backup:export':
      return exportBackup(!!msg.includeCookies);
    case 'backup:import': {
      if (typeof msg.json !== 'string' || msg.json.length > 20_000_000) throw new Error('Ungültige Datei.');
      const { result, changedCids } = await importBackup(msg.json);
      for (const cid of changedCids) await onJarChanged(cid);
      await adoptOpenGroups();
      return result;
    }
    case 'maintenance:clearServiceWorkers': {
      await chrome.browsingData.remove(
        { origins: [...KNOWN_APP_ORIGINS] as [string, ...string[]] },
        { serviceWorkers: true, cacheStorage: true },
      );
      return true;
    }
  }
  throw new Error('Unbekannte Anfrage.');
}

// Beim Suspendieren des Workers ausstehende Cookie-Schreibvorgänge sichern.
chrome.runtime.onSuspend.addListener(() => void flush());
