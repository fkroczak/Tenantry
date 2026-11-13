/**
 * Abfangen von Set-Cookie-Antworten in Container-Tabs.
 *
 * MV3 erlaubt kein blockierendes webRequest mehr, beobachtende Listener
 * (inkl. "extraHeaders" für Set-Cookie) aber schon. Chrome speichert die
 * Cookies deshalb trotzdem zusätzlich im nativen Cookie-Speicher. Diese
 * Kopien entfernt `scrubNative` direkt wieder, damit Tabs ohne Container nicht
 * versehentlich in einem Container-Tenant angemeldet werden.
 *
 * Für die Container-Tabs selbst ist der native Speicher ohnehin irrelevant:
 * die DNR-Regeln ersetzen den Cookie-Header vollständig.
 */
import { parseSetCookie, type StoredCookie } from '../shared/cookies';
import { inScope } from '../shared/scope';
import { warn } from './util';

/** Cookies, deren native Kopie wir in den nächsten Sekunden entfernen wollen. */
const pendingScrub = new Map<string, { until: number; host: string }>();
const SCRUB_WINDOW_MS = 15_000;

function scrubKey(name: string, domain: string, path: string, value: string): string {
  return [name, domain.replace(/^\./, ''), path, value].join('\u0000');
}

export function extractSetCookies(details: chrome.webRequest.OnHeadersReceivedDetails): string[] {
  const out: string[] = [];
  for (const h of details.responseHeaders ?? []) {
    if (h.name.toLowerCase() !== 'set-cookie' || !h.value) continue;
    // Chrome liefert mehrere Set-Cookie-Header teils mit \n verbunden.
    out.push(...h.value.split('\n').filter(Boolean));
  }
  return out;
}

export function parseResponseCookies(details: chrome.webRequest.OnHeadersReceivedDetails, headers: string[]): StoredCookie[] {
  let url: URL;
  try {
    url = new URL(details.url);
  } catch {
    return [];
  }
  if (!inScope(url.hostname)) return [];
  const now = Date.now();
  const out: StoredCookie[] = [];
  for (const h of headers) {
    const c = parseSetCookie(h, url, now);
    // Der Parser stellt sicher, dass die Cookie-Domain zum (Scope-)Host passt.
    if (c) out.push(c);
  }
  return out;
}

/**
 * Entfernt die native Kopie gerade erfasster Container-Cookies.
 * `requestHost` ist der Host der Antwort: chrome.cookies verlangt eine
 * Host-Berechtigung für die URL, und z. B. für "microsoftonline.com" selbst
 * (Domain-Cookie von login.microsoftonline.com) gibt es keine.
 */
export function scrubNative(cookies: StoredCookie[], requestHost: string): void {
  const now = Date.now();
  for (const c of cookies) {
    pendingScrub.set(scrubKey(c.name, c.domain, c.path, c.value), { until: now + SCRUB_WINDOW_MS, host: requestHost });
    void removeNativeMatching(c, requestHost);
    // Chrome legt das Cookie evtl. erst nach onHeadersReceived ab -> nachfassen.
    setTimeout(() => void removeNativeMatching(c, requestHost), 1500);
  }
}

async function removeNativeMatching(c: StoredCookie, host: string): Promise<void> {
  try {
    const list = await chrome.cookies.getAll({ name: c.name, url: `https://${host}${c.path}` });
    for (const n of list) {
      if (n.domain.replace(/^\./, '') !== c.domain || n.path !== c.path || n.value !== c.value) continue;
      await removeNative(n, host);
    }
  } catch (e) {
    warn('Native Cookie-Bereinigung fehlgeschlagen', e);
  }
}

async function removeNative(n: chrome.cookies.Cookie, host: string): Promise<void> {
  const details: chrome.cookies.CookieDetails & { partitionKey?: unknown } = {
    url: `https://${host}${n.path}`,
    name: n.name,
    storeId: n.storeId,
  };
  const pk = (n as { partitionKey?: unknown }).partitionKey;
  if (pk) details.partitionKey = pk;
  await chrome.cookies.remove(details as chrome.cookies.CookieDetails);
}

/** Listener für chrome.cookies.onChanged. */
export function onNativeCookieChanged(info: chrome.cookies.CookieChangeInfo): void {
  if (info.removed) return;
  const now = Date.now();
  for (const [k, p] of pendingScrub) if (p.until < now) pendingScrub.delete(k);
  const n = info.cookie;
  const key = scrubKey(n.name, n.domain, n.path, n.value);
  const p = pendingScrub.get(key);
  if (p) {
    pendingScrub.delete(key);
    void removeNative(n, p.host).catch(() => undefined);
  }
}
