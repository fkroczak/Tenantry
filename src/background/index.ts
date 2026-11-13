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
import { hasRules, initDnr, syncTabs } from './dnr';
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
import { log, randomId, warn } from './util';

const EXTERNAL_IDP_ORIGINS = ['https://*/*'];

// ---------------------------------------------------------------------------
// Initialisierung
// ---------------------------------------------------------------------------

const ready: Promise<void> = boot().catch((e) => {
  warn('Start fehlgeschlagen', e);
});

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
}

// ---------------------------------------------------------------------------
// Container <-> Tab
// ---------------------------------------------------------------------------

async function assignTab(tabId: number, cid: string | null, opts: { reload?: boolean } = {}): Promise<void> {
  if (cid) state.tabs.set(tabId, cid);
  else state.tabs.delete(tabId);
  await saveTabs();
  await syncTabs([tabId]);
  updateBadge(tabId);
  if (cid) void ensureGrouped(tabId);
  if (opts.reload) await chrome.tabs.reload(tabId).catch(() => undefined);
}

function updateBadge(tabId: number): void {
  const c = containerOfTab(tabId);
  const text = c ? c.name.replace(/[^\p{L}\p{N}]/gu, '').slice(0, 2).toUpperCase() || '•' : '';
  chrome.action.setBadgeText({ tabId, text }).catch(() => undefined);
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

chrome.tabs.onCreated.addListener((tab) => {
  void ready.then(async () => {
    if (tab.id === undefined || tab.openerTabId === undefined || state.tabs.has(tab.id)) return;
    const cid = state.tabs.get(tab.openerTabId);
    if (cid) await assignTab(tab.id, cid);
  });
});

chrome.webNavigation.onCreatedNavigationTarget.addListener((d) => {
  void ready.then(async () => {
    if (state.tabs.has(d.tabId)) return;
    const cid = state.tabs.get(d.sourceTabId);
    if (cid) await assignTab(d.tabId, cid);
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
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
      if (applyCookies(cid, cookies)) await onJarChanged(cid);
    });
    return undefined;
  },
  { urls: [...SCOPE_MATCH_PATTERNS] },
  ['responseHeaders', 'extraHeaders'],
);

chrome.cookies.onChanged.addListener(onNativeCookieChanged);

chrome.alarms.onAlarm.addListener((a) => {
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
      return res;
    }
    case 'content:setCookie': {
      if (!cid || typeof msg.cookie !== 'string' || !urlInScope(sender.url)) return false;
      const parsed = parseSetCookie(msg.cookie, new URL(sender.url!), Date.now(), { fromScript: true });
      if (!parsed) return false;
      if (applyCookies(cid, [parsed], { fromScript: true })) await onJarChanged(cid);
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
      await saveContainers();
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
