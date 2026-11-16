/**
 * Erkennt Seitennavigationen, die mit veralteten Container-Cookies gesendet
 * wurden.
 *
 * Hintergrund: Set-Cookie wird in onHeadersReceived beobachtet, die
 * DNR-Regeln werden danach asynchron aktualisiert. Folgt der Browser einem
 * 302 sofort (z. B. SharePoint: POST /_forms/default.aspx -> 302 mit FedAuth
 * -> Zielseite), geht der Folge-Request noch mit den alten Regeln raus. Die
 * Zielseite sieht dann kein Anmelde-Cookie und bricht ab ("Das hat leider
 * nicht geklappt").
 *
 * Abhilfe: Der tatsächlich gesendete Cookie-Header (webRequest.onSendHeaders
 * mit extraHeaders, inkl. DNR-Änderungen) wird mit dem Container-Speicher
 * verglichen. Fehlen Cookies, die zum Sendezeitpunkt schon bekannt waren,
 * wird die Navigation nach dem Aktualisieren der Regeln wiederholt.
 */
import { cookieMatchesUrl, isExpired, type StoredCookie } from '../shared/cookies';

/** Parst einen Cookie-Request-Header in name -> Werte. */
export function parseCookieHeader(header: string | undefined): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const part of (header ?? '').split(';')) {
    const p = part.trim();
    if (!p) continue;
    const eq = p.indexOf('=');
    const name = eq === -1 ? '' : p.slice(0, eq).trim();
    const value = eq === -1 ? p : p.slice(eq + 1).trim();
    let set = out.get(name);
    if (!set) out.set(name, (set = new Set()));
    set.add(value);
  }
  return out;
}

/**
 * Namen der Container-Cookies, die für `url` hätten gesendet werden müssen,
 * im Header aber fehlen (oder mit anderem Wert gesendet wurden).
 * Berücksichtigt nur Cookies, die vor `sentAt` gespeichert wurden, und keine
 * SameSite=Strict-Cookies (die hängen vom Initiator ab).
 */
export function missingCookies(jar: StoredCookie[], url: string, sentHeader: string | undefined, sentAt: number): string[] {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return [];
  }
  const expected = new Map<string, Set<string>>();
  for (const c of jar) {
    if (isExpired(c, sentAt) || c.created > sentAt || c.sameSite === 'strict') continue;
    if (!cookieMatchesUrl(c, u)) continue;
    let set = expected.get(c.name);
    if (!set) expected.set(c.name, (set = new Set()));
    set.add(c.value);
  }
  const sent = parseCookieHeader(sentHeader);
  const missing: string[] = [];
  for (const [name, values] of expected) {
    const got = sent.get(name);
    if (!got || ![...values].some((v) => got.has(v))) missing.push(name);
  }
  return missing;
}

/** Begrenzung, damit ein unerwarteter Fehler keine Endlosschleife auslöst. */
export class RetryLimiter {
  private readonly hits = new Map<number, number[]>();
  constructor(
    private readonly max = 3,
    private readonly windowMs = 30_000,
  ) {}

  allow(tabId: number, now: number): boolean {
    const list = (this.hits.get(tabId) ?? []).filter((t) => now - t < this.windowMs);
    if (list.length >= this.max) {
      this.hits.set(tabId, list);
      return false;
    }
    list.push(now);
    this.hits.set(tabId, list);
    return true;
  }

  forget(tabId: number): void {
    this.hits.delete(tabId);
  }
}
