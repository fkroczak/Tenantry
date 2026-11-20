/**
 * Reine Hilfsfunktionen für die Diagnose-Aufzeichnung (testbar, ohne chrome.*).
 *
 * Grundsatz: Es werden KEINE Cookie-Werte, Token oder Formularinhalte
 * gespeichert. Statt Werten gibt es einen kurzen Fingerabdruck
 * (Länge + 24-Bit-Hash), damit sich erkennen lässt, ob ein gesendetes Cookie
 * dem im Container gespeicherten entspricht oder ob es rotiert wurde.
 */
import { cookieMatchesUrl, isExpired, type StoredCookie } from '../shared/cookies';
import { parseCookieHeader } from './stale';

/** Fingerabdruck eines Werts: "<Länge>:<6 Hex-Zeichen>" (FNV-1a, nicht umkehrbar). */
export function fingerprint(value: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${value.length}:${(h >>> 8).toString(16).padStart(6, '0')}`;
}

/** Query-Parameter, deren Werte unkritisch und für die Analyse nützlich sind. */
const SAFE_PARAMS = new Set([
  'client_id',
  'response_mode',
  'response_type',
  'prompt',
  'sso_reload',
  'redirect_uri',
  'scope',
  'resource',
  'wa',
  'wtrealm',
  'wreply',
  'source',
  'returnurl',
  'ru',
  'mkt',
  'lc',
  'ui_locales',
  'x-client-sku',
  'x-client-ver',
  'claims',
  'amr_values',
  'max_age',
]);

/** URL ohne Fragment; Query-Werte außer SAFE_PARAMS werden durch ihre Länge ersetzt. */
export function redactUrl(raw: string | undefined): string {
  if (!raw) return '';
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return '(ungültige URL)';
  }
  const parts: string[] = [];
  for (const [k, v] of u.searchParams) {
    parts.push(SAFE_PARAMS.has(k.toLowerCase()) ? `${k}=${v}` : `${k}=<${v.length}>`);
  }
  return `${u.origin}${u.pathname}${parts.length ? '?' + parts.join('&') : ''}`;
}

/** Gesendeter Cookie-Header -> ["name=fp", ...] (ohne Werte). */
export function summarizeCookieHeader(header: string | undefined): string[] {
  const out: string[] = [];
  for (const [name, values] of parseCookieHeader(header)) {
    for (const v of values) out.push(`${name}=${fingerprint(v)}`);
  }
  return out;
}

/** Ein Set-Cookie-Header -> kompakte Beschreibung ohne Wert. */
export function summarizeSetCookie(header: string): string {
  const parts = header.split(';');
  const pair = (parts.shift() ?? '').trim();
  const eq = pair.indexOf('=');
  const name = eq === -1 ? '' : pair.slice(0, eq).trim();
  const value = eq === -1 ? pair : pair.slice(eq + 1).trim();
  const attrs: string[] = [];
  for (const raw of parts) {
    const a = raw.trim();
    if (!a) continue;
    const i = a.indexOf('=');
    const key = (i === -1 ? a : a.slice(0, i)).trim().toLowerCase();
    // Attribute enthalten keine Geheimnisse; nur unbekannte Attribute kürzen.
    if (['domain', 'path', 'expires', 'max-age', 'samesite', 'secure', 'httponly', 'partitioned', 'priority'].includes(key)) {
      attrs.push(a);
    } else {
      attrs.push(`${key}=<…>`);
    }
  }
  return [`${name}=${fingerprint(value)}`, ...attrs].join('; ');
}

export interface CookieComparison {
  /** Im Container vorhanden und für die URL gültig, aber nicht gesendet. */
  missing: string[];
  /** Gesendet, aber mit anderem Wert als im Container. */
  differs: string[];
  /** Gesendet, aber im Container unbekannt (z. B. aus dem nativen Speicher). */
  unknown: string[];
}

/**
 * Vergleicht den gesendeten Cookie-Header mit dem aktuellen Container-Speicher
 * (Zeitpunkt der Auswertung, nicht des Sendens).
 */
export function compareWithJar(jar: StoredCookie[], url: string, sentHeader: string | undefined, now: number): CookieComparison {
  const res: CookieComparison = { missing: [], differs: [], unknown: [] };
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return res;
  }
  const expected = new Map<string, Set<string>>();
  for (const c of jar) {
    if (isExpired(c, now) || !cookieMatchesUrl(c, u)) continue;
    let set = expected.get(c.name);
    if (!set) expected.set(c.name, (set = new Set()));
    set.add(c.value);
  }
  const sent = parseCookieHeader(sentHeader);
  for (const [name, values] of expected) {
    const got = sent.get(name);
    if (!got) res.missing.push(name);
    else if (![...values].some((v) => got.has(v))) res.differs.push(name);
  }
  for (const name of sent.keys()) if (!expected.has(name)) res.unknown.push(name);
  return res;
}

/** Formularfelder eines POST-Bodys: nur Namen und Länge der Werte. */
export function summarizeFormData(formData: Record<string, unknown> | undefined): string[] | undefined {
  if (!formData) return undefined;
  return Object.entries(formData).map(([k, v]) => {
    const first = Array.isArray(v) ? v[0] : v;
    return `${k}=<${typeof first === 'string' ? first.length : '?'}>`;
  });
}
