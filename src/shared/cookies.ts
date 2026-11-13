/**
 * Minimaler RFC-6265-Cookie-Speicher (Parser, Matching, Serialisierung).
 * Wird im Service Worker UND im MAIN-World-Content-Script genutzt, daher
 * ohne chrome.*-Abhängigkeiten.
 */
export type SameSite = 'strict' | 'lax' | 'none' | 'unspecified';

export interface StoredCookie {
  name: string;
  value: string;
  /** Kleingeschrieben, ohne führenden Punkt. */
  domain: string;
  /** true = nur exakt dieser Host (kein Domain-Attribut gesetzt). */
  hostOnly: boolean;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: SameSite;
  /** Ablauf in ms seit Epoch; null = Session-Cookie. */
  expires: number | null;
  /** Erstellzeitpunkt (für die Sortierung im Cookie-Header). */
  created: number;
}

const MAX_AGE_MS = 400 * 24 * 60 * 60 * 1000; // Chrome-Limit: 400 Tage

export function cookieKey(c: Pick<StoredCookie, 'name' | 'domain' | 'path'>): string {
  return `${c.name}\u0000${c.domain}\u0000${c.path}`;
}

/** RFC 6265 5.1.3 (ohne IP-Sonderfall, Scope enthält keine IPs). */
export function domainMatch(host: string, domain: string): boolean {
  return host === domain || host.endsWith('.' + domain);
}

/** RFC 6265 5.1.4 */
export function defaultPath(pathname: string): string {
  if (!pathname.startsWith('/')) return '/';
  const idx = pathname.lastIndexOf('/');
  return idx <= 0 ? '/' : pathname.slice(0, idx);
}

export function pathMatch(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith('/') || requestPath.charAt(cookiePath.length) === '/';
}

export function isExpired(c: StoredCookie, now: number): boolean {
  return c.expires !== null && c.expires <= now;
}

export interface ParseOptions {
  /** true = über document.cookie gesetzt (HttpOnly verboten). */
  fromScript?: boolean;
}

/**
 * Parst einen Set-Cookie-Header (oder einen document.cookie-Zuweisungsstring).
 * Gibt null zurück, wenn das Cookie verworfen werden muss. Ein Cookie mit
 * `expires <= now` bedeutet "löschen".
 */
export function parseSetCookie(
  header: string,
  url: URL,
  now: number,
  opts: ParseOptions = {},
): StoredCookie | null {
  const parts = header.split(';');
  const pair = (parts.shift() ?? '').trim();
  const eq = pair.indexOf('=');
  const name = eq === -1 ? '' : pair.slice(0, eq).trim();
  const value = eq === -1 ? pair : pair.slice(eq + 1).trim();
  if (!name && !value) return null;
  if (/[\x00-\x08\x0a-\x1f\x7f]/.test(name + value)) return null;

  const host = url.hostname.toLowerCase();
  let domainAttr: string | null = null;
  let path: string | null = null;
  let secure = false;
  let httpOnly = false;
  let sameSite: SameSite = 'unspecified';
  let expires: number | null = null;
  let maxAge: number | null = null;

  for (const raw of parts) {
    const i = raw.indexOf('=');
    const key = (i === -1 ? raw : raw.slice(0, i)).trim().toLowerCase();
    const val = i === -1 ? '' : raw.slice(i + 1).trim();
    switch (key) {
      case 'expires': {
        const t = Date.parse(val);
        if (!Number.isNaN(t)) expires = t;
        break;
      }
      case 'max-age':
        if (/^-?\d+$/.test(val)) {
          const s = parseInt(val, 10);
          maxAge = s <= 0 ? -Infinity : s * 1000;
        }
        break;
      case 'domain': {
        const d = val.replace(/^\./, '').toLowerCase();
        if (d) domainAttr = d;
        break;
      }
      case 'path':
        path = val.startsWith('/') ? val : null;
        break;
      case 'secure':
        secure = true;
        break;
      case 'httponly':
        httpOnly = true;
        break;
      case 'samesite': {
        const v = val.toLowerCase();
        sameSite = v === 'strict' || v === 'lax' || v === 'none' ? v : 'unspecified';
        break;
      }
    }
  }

  if (opts.fromScript && httpOnly) return null;
  if (secure && url.protocol !== 'https:') return null;

  let domain = host;
  let hostOnly = true;
  if (domainAttr) {
    if (!domainMatch(host, domainAttr) || !domainAttr.includes('.')) return null;
    domain = domainAttr;
    hostOnly = false;
  }

  const finalPath = path ?? defaultPath(url.pathname);

  // Cookie-Präfixe
  if (name.startsWith('__Secure-') && !secure) return null;
  if (name.startsWith('__Host-') && (!secure || domainAttr !== null || finalPath !== '/')) return null;

  let exp: number | null = null;
  if (maxAge !== null) exp = maxAge === -Infinity ? now - 1 : now + Math.min(maxAge, MAX_AGE_MS);
  else if (expires !== null) exp = Math.min(expires, now + MAX_AGE_MS);

  return {
    name,
    value,
    domain,
    hostOnly,
    path: finalPath,
    secure,
    httpOnly,
    sameSite,
    expires: exp,
    created: now,
  };
}

/** Prüft, ob ein Cookie zu Host/Pfad/Schema passt (ohne SameSite). */
export function cookieMatchesUrl(c: StoredCookie, url: { hostname: string; pathname: string; protocol: string }): boolean {
  const host = url.hostname.toLowerCase();
  const hostOk = c.hostOnly ? host === c.domain : domainMatch(host, c.domain);
  if (!hostOk) return false;
  if (!pathMatch(url.pathname || '/', c.path)) return false;
  if (c.secure && url.protocol !== 'https:') return false;
  return true;
}

/** RFC 6265 5.4: längere Pfade zuerst, dann ältere Cookies zuerst. */
export function sortForHeader(list: StoredCookie[]): StoredCookie[] {
  return [...list].sort((a, b) => b.path.length - a.path.length || a.created - b.created);
}

export function serializeCookies(list: StoredCookie[]): string {
  return sortForHeader(list)
    .map((c) => (c.name ? `${c.name}=${c.value}` : c.value))
    .join('; ');
}

/**
 * Wendet ein geparstes Cookie auf einen Speicher an. Gibt true zurück, wenn
 * sich der Speicher geändert hat.
 */
export function applyCookie(
  jar: Map<string, StoredCookie>,
  cookie: StoredCookie,
  now: number,
  opts: ParseOptions = {},
): boolean {
  const key = cookieKey(cookie);
  const existing = jar.get(key);
  if (existing && opts.fromScript && existing.httpOnly) return false;
  if (isExpired(cookie, now)) {
    return jar.delete(key);
  }
  const next: StoredCookie = existing ? { ...cookie, created: existing.created } : cookie;
  if (
    existing &&
    existing.value === next.value &&
    existing.expires === next.expires &&
    existing.secure === next.secure &&
    existing.httpOnly === next.httpOnly &&
    existing.sameSite === next.sameSite &&
    existing.hostOnly === next.hostOnly
  ) {
    return false;
  }
  jar.set(key, next);
  return true;
}
