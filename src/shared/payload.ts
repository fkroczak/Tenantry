/**
 * Kompakte Übertragung des Container-Kontexts an die Seite.
 *
 * Der Service Worker hängt per declarativeNetRequest an jede Antwort in einem
 * Container-Tab einen `Server-Timing`-Header an:
 *
 *   Server-Timing: tenantry;desc="<base64url(JSON)>"
 *
 * Das MAIN-World-Script liest ihn bei document_start SYNCHRON über
 * performance.getEntriesByType('navigation')[0].serverTiming und kennt so
 * Container-ID und JS-sichtbare Cookies, bevor irgendein Seiten-Script (MSAL!)
 * läuft.
 */
import type { StoredCookie } from './cookies';

export const SERVER_TIMING_NAME = 'tenantry';
/** Größere Payloads werden ohne Cookies gesendet (Cookies kommen dann per Bridge). */
export const MAX_PAYLOAD_CHARS = 16_000;

/** [name, value, domain, hostOnly, path, secure, expires|0, created] */
export type CookieTuple = [string, string, string, 0 | 1, string, 0 | 1, number, number];

export interface ContextPayload {
  v: 1;
  /** Container-ID */
  c: string;
  /** JS-sichtbare Cookies (ohne HttpOnly). Fehlt, wenn zu groß. */
  k?: CookieTuple[];
}

export function toTuple(c: StoredCookie): CookieTuple {
  return [c.name, c.value, c.domain, c.hostOnly ? 1 : 0, c.path, c.secure ? 1 : 0, c.expires ?? 0, c.created];
}

export function fromTuple(t: CookieTuple): StoredCookie {
  return {
    name: t[0],
    value: t[1],
    domain: t[2],
    hostOnly: t[3] === 1,
    path: t[4],
    secure: t[5] === 1,
    httpOnly: false,
    sameSite: 'unspecified',
    expires: t[6] === 0 ? null : t[6],
    created: t[7],
  };
}

function b64urlEncode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): string {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function encodePayload(p: ContextPayload): string {
  let enc = b64urlEncode(JSON.stringify(p));
  if (enc.length > MAX_PAYLOAD_CHARS && p.k) {
    enc = b64urlEncode(JSON.stringify({ v: p.v, c: p.c }));
  }
  return enc;
}

export function serverTimingValue(p: ContextPayload): string {
  return `${SERVER_TIMING_NAME};desc="${encodePayload(p)}"`;
}

export function decodePayload(desc: string): ContextPayload | null {
  try {
    const p = JSON.parse(b64urlDecode(desc)) as ContextPayload;
    if (p && p.v === 1 && typeof p.c === 'string' && p.c) return p;
  } catch {
    /* ignorieren */
  }
  return null;
}
