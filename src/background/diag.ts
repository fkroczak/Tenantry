/**
 * Diagnose-Aufzeichnung (über das Popup ein- und ausschaltbar).
 *
 * Protokolliert Requests an Scope-Domains (Methode, Status, Weiterleitungen,
 * Cookie-NAMEN mit Fingerabdruck, Set-Cookie-Attribute, Formularfeld-Namen)
 * sowie Tenantrys eigene Schritte (Regel-Updates, Wiederholungen,
 * Script-Cookies). Werte von Cookies, Token und Formularen werden nie
 * gespeichert, siehe diagFormat.ts.
 *
 * Die Einträge liegen in chrome.storage.session, damit sie ein Schlafen des
 * Service Workers überstehen; sie verfallen mit dem Browser.
 */
import { SCOPE_MATCH_PATTERNS } from '../shared/scope';
import type { DiagStatus } from '../shared/types';
import {
  compareWithJar,
  redactUrl,
  summarizeCookieHeader,
  summarizeFormData,
  summarizeSetCookie,
} from './diagFormat';
import { listCookies } from './jar';
import { containerById, state } from './state';

const STATE_KEY = 'diag:state';
const ENTRIES_KEY = 'diag:entries';
const MAX_ENTRIES = 4000;
/** Aufzeichnung endet automatisch, damit sie nicht vergessen wird. */
const MAX_DURATION_MS = 30 * 60 * 1000;

export interface DiagEntry {
  t: number;
  kind: string;
  tab?: number;
  container?: string;
  [k: string]: unknown;
}


let recording = false;
let since: number | null = null;
let entries: DiagEntry[] = [];
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let loadedDone = false;

/** Schneller Vorfilter in Listenern: vor dem Laden des Zustands alles annehmen, diag() prüft dann genau. */
const maybe = (): boolean => recording || !loadedDone;

const loaded: Promise<void> = (async () => {
  try {
    const got = await chrome.storage.session.get([STATE_KEY, ENTRIES_KEY]);
    const s = got[STATE_KEY] as { recording?: boolean; since?: number } | undefined;
    recording = !!s?.recording;
    since = s?.since ?? null;
    entries = Array.isArray(got[ENTRIES_KEY]) ? (got[ENTRIES_KEY] as DiagEntry[]) : [];
  } catch {
    // ohne gespeicherten Zustand starten
  }
  loadedDone = true;
})();

function active(now = Date.now()): boolean {
  if (!recording) return false;
  if (since !== null && now - since > MAX_DURATION_MS) {
    recording = false;
    entries.push({ t: now, kind: 'diag:autostop' });
    void persist();
    return false;
  }
  return true;
}

function scheduleSave(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => void persist(), 1000);
}

async function persist(): Promise<void> {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  await chrome.storage.session
    .set({ [STATE_KEY]: { recording, since }, [ENTRIES_KEY]: entries })
    .catch(() => undefined);
}

function containerName(tabId: number | undefined): string | undefined {
  if (tabId === undefined || tabId < 0) return undefined;
  const cid = state.tabs.get(tabId);
  if (!cid) return '(kein Container)';
  return containerById(cid)?.name ?? cid;
}

/** Eintrag hinzufügen (no-op, wenn nicht aufgezeichnet wird). */
export function diag(kind: string, data: Omit<DiagEntry, 't' | 'kind'> = {}, t = Date.now()): void {
  void loaded.then(() => {
    if (!active()) return;
    const e: DiagEntry = { t: Math.round(t), kind, ...data };
    if (e.tab !== undefined && e.container === undefined) e.container = containerName(e.tab);
    entries.push(e);
    if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
    scheduleSave();
  });
}

export async function diagStatus(): Promise<DiagStatus> {
  await loaded;
  active();
  return { recording, since, count: entries.length };
}

export async function diagStart(): Promise<DiagStatus> {
  await loaded;
  recording = true;
  since = Date.now();
  entries.push({
    t: since,
    kind: 'diag:start',
    version: chrome.runtime.getManifest().version,
    userAgent: navigator.userAgent,
    containers: state.containers.map((c) => c.name),
  });
  await persist();
  return diagStatus();
}

export async function diagStop(): Promise<DiagStatus> {
  await loaded;
  if (recording) entries.push({ t: Date.now(), kind: 'diag:stop' });
  recording = false;
  await persist();
  return diagStatus();
}

export async function diagClear(): Promise<DiagStatus> {
  await loaded;
  entries = [];
  if (recording) since = Date.now();
  await persist();
  return diagStatus();
}

export async function diagExport(): Promise<string> {
  await loaded;
  const doc = {
    format: 'tenantry-diagnose/1',
    exportedAt: new Date().toISOString(),
    version: chrome.runtime.getManifest().version,
    hinweis:
      'Enthält keine Cookie-Werte, Token oder Formularinhalte. Werte erscheinen als <Länge>:<Prüfsumme>, ' +
      'URL-Parameter (außer z. B. client_id/response_mode) nur als <Länge>.',
    containers: state.containers.map((c) => ({ name: c.name, tabs: [...state.tabs].filter(([, cid]) => cid === c.id).map(([t]) => t) })),
    entries: entries.map((e) => ({ ...e, time: new Date(e.t).toISOString().slice(11, 23) })),
  };
  return JSON.stringify(doc, null, 1);
}

// ---------------------------------------------------------------------------
// webRequest-Beobachtung (nur Scope-Domains, nur während der Aufzeichnung)
// ---------------------------------------------------------------------------

const TYPES: chrome.webRequest.ResourceType[] = ['main_frame', 'sub_frame', 'xmlhttprequest', 'other'] as chrome.webRequest.ResourceType[];
const filter: chrome.webRequest.RequestFilter = { urls: [...SCOPE_MATCH_PATTERNS], types: TYPES };

function base(d: { tabId: number; frameId: number; type: string; method?: string; requestId: string; url: string }) {
  return { tab: d.tabId, frame: d.frameId, type: d.type, method: d.method, req: d.requestId, url: redactUrl(d.url) };
}

/**
 * Registriert die Listener (synchron auf Top-Level aufrufen). `ready` ist der
 * Startzustand des Service Workers; erst danach sind Container und Cookies geladen.
 */
export function registerDiagListeners(ready: Promise<void>): void {
  chrome.webRequest.onBeforeRequest.addListener(
    (d) => {
      if (!maybe()) return undefined;
      const form = summarizeFormData(d.requestBody?.formData as Record<string, unknown> | undefined);
      diag('req', { ...base(d), initiator: d.initiator, ...(form ? { form } : {}) }, d.timeStamp);
      return undefined;
    },
    filter,
    ['requestBody'],
  );

  chrome.webRequest.onSendHeaders.addListener(
    (d) => {
      if (!maybe()) return;
      const header = d.requestHeaders?.find((h) => h.name.toLowerCase() === 'cookie')?.value;
      void ready.then(() => {
        const cid = d.tabId >= 0 ? state.tabs.get(d.tabId) : undefined;
        const cmp = cid ? compareWithJar(listCookies(cid), d.url, header, Date.now()) : undefined;
        diag(
          'send',
          {
            ...base(d),
            cookies: summarizeCookieHeader(header),
            ...(cmp && (cmp.missing.length || cmp.differs.length || cmp.unknown.length) ? { vsContainer: cmp } : {}),
          },
          d.timeStamp,
        );
      });
    },
    filter,
    ['requestHeaders', 'extraHeaders'],
  );

  chrome.webRequest.onHeadersReceived.addListener(
    (d) => {
      if (!maybe()) return undefined;
      const setCookies: string[] = [];
      let location: string | undefined;
      for (const h of d.responseHeaders ?? []) {
        const n = h.name.toLowerCase();
        if (n === 'set-cookie' && h.value) setCookies.push(...h.value.split('\n').filter(Boolean).map(summarizeSetCookie));
        else if (n === 'location' && h.value) location = redactUrl(new URL(h.value, d.url).href);
      }
      diag(
        'resp',
        {
          ...base(d),
          status: d.statusCode,
          ...(location ? { location } : {}),
          ...(setCookies.length ? { setCookies } : {}),
        },
        d.timeStamp,
      );
      return undefined;
    },
    filter,
    ['responseHeaders', 'extraHeaders'],
  );

  chrome.webRequest.onErrorOccurred.addListener((d) => {
    if (!maybe()) return;
    diag('error', { ...base(d), error: d.error }, d.timeStamp);
  }, filter);

  chrome.webNavigation.onCommitted.addListener((d) => {
    if (!maybe() || d.frameId !== 0) return;
    diag('nav:committed', { tab: d.tabId, url: redactUrl(d.url), transition: d.transitionType, qualifiers: d.transitionQualifiers }, d.timeStamp);
  });
}
