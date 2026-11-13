/**
 * Reiner (testbarer) Generator für declarativeNetRequest-Session-Rules eines
 * Container-Tabs.
 *
 * Idee: Für jeden Tab werden Regeln erzeugt, die den `Cookie`-Request-Header
 * für Scope-Domains durch die Cookies des Containers ERSETZEN. Damit ist der
 * native Cookie-Speicher von Chrome für diese Requests irrelevant.
 *
 * Schlüssel ("Keys") ergeben sich aus den Cookies:
 *   - exact(d): Host-only-Cookies von d -> urlFilter "|https://d/" (nur dieser Host)
 *   - sub(d):   Domain-Cookies für d     -> requestDomains [d] (d + Subdomains)
 * Jede Regel enthält ALLE Cookies, die für Requests an diesen Key gelten
 * (inkl. Domain-Cookies übergeordneter Domains). Spezifischere Keys erhalten
 * höhere Priorität; bei modifyHeaders gewinnt für denselben Header die Regel
 * mit der höchsten Priorität.
 *
 * SameSite (vereinfacht): Variante A (Initiator gleiche Site) enthält alle
 * Cookies, Variante B (alle anderen Initiatoren) nur Nicht-Strict-Cookies.
 *
 * Zusätzlich setzt jede Regel einen `Server-Timing`-Response-Header mit
 * Container-ID + JS-sichtbaren Cookies (siehe shared/payload.ts).
 */
import { domainMatch, isExpired, serializeCookies, type StoredCookie } from '../shared/cookies';
import { serverTimingValue, toTuple } from '../shared/payload';
import { siteOf } from '../shared/scope';

export const ALL_RESOURCE_TYPES = [
  'main_frame',
  'sub_frame',
  'stylesheet',
  'script',
  'image',
  'font',
  'object',
  'xmlhttprequest',
  'ping',
  'csp_report',
  'media',
  'websocket',
  'webtransport',
  'webbundle',
  'other',
] as const;

/** Strukturell kompatibel zu chrome.declarativeNetRequest.Rule (ohne id). */
export interface RuleSpec {
  priority: number;
  condition: {
    tabIds: number[];
    resourceTypes: string[];
    urlFilter?: string;
    requestDomains?: string[];
    initiatorDomains?: string[];
  };
  action: {
    type: 'modifyHeaders';
    requestHeaders: { header: string; operation: 'set' | 'remove'; value?: string }[];
    responseHeaders: { header: string; operation: 'set'; value: string }[];
  };
}

export interface BuildInput {
  tabId: number;
  containerId: string;
  cookies: StoredCookie[];
  scopeDomains: readonly string[];
  now: number;
}

interface Key {
  domain: string;
  exact: boolean;
}

function labels(d: string): number {
  return d.split('.').length;
}

function cookiesForKey(all: StoredCookie[], key: Key): StoredCookie[] {
  return all.filter((c) => {
    if (key.exact) {
      // Exakter Host: Host-only-Cookies dieses Hosts + passende Domain-Cookies.
      return c.hostOnly ? c.domain === key.domain : domainMatch(key.domain, c.domain);
    }
    // Subdomain-Regel: nur Domain-Cookies (Host-only gelten nicht für Subdomains).
    return !c.hostOnly && domainMatch(key.domain, c.domain);
  });
}

/** Dedupliziert gleichnamige Cookies: der Pfad-spezifischste gewinnt (Pfade werden nicht einzeln abgebildet). */
function dedupeByName(list: StoredCookie[]): StoredCookie[] {
  const byName = new Map<string, StoredCookie>();
  for (const c of list) {
    const prev = byName.get(c.name);
    if (!prev || c.path.length > prev.path.length || (c.path.length === prev.path.length && labels(c.domain) > labels(prev.domain))) {
      byName.set(c.name, c);
    }
  }
  return [...byName.values()];
}

function requestHeader(list: StoredCookie[]): RuleSpec['action']['requestHeaders'][number] {
  const value = serializeCookies(dedupeByName(list));
  return value ? { header: 'cookie', operation: 'set', value } : { header: 'cookie', operation: 'remove' };
}

export function buildTabRules(input: BuildInput): RuleSpec[] {
  const { tabId, containerId, now } = input;
  const cookies = input.cookies.filter((c) => !isExpired(c, now));
  const resourceTypes = [...ALL_RESOURCE_TYPES];
  const rules: RuleSpec[] = [];

  // Catch-all (niedrigste Priorität): keine Cookies aus dem nativen Speicher
  // durchlassen und Container-ID an die Seite melden.
  rules.push({
    priority: 1,
    condition: { tabIds: [tabId], resourceTypes, requestDomains: [...input.scopeDomains] },
    action: {
      type: 'modifyHeaders',
      requestHeaders: [{ header: 'cookie', operation: 'remove' }],
      responseHeaders: [{ header: 'server-timing', operation: 'set', value: serverTimingValue({ v: 1, c: containerId, k: [] }) }],
    },
  });

  const keys = new Map<string, Key>();
  for (const c of cookies) {
    const k: Key = { domain: c.domain, exact: c.hostOnly };
    keys.set(`${k.exact ? 'e' : 's'}:${k.domain}`, k);
  }

  for (const key of keys.values()) {
    const applicable = cookiesForKey(cookies, key);
    const jsVisible = applicable.filter((c) => !c.httpOnly).map(toTuple);
    const response = [{ header: 'server-timing', operation: 'set' as const, value: serverTimingValue({ v: 1, c: containerId, k: jsVisible }) }];
    const base = 100 + labels(key.domain) * 10 + (key.exact ? 4 : 0);
    const target = key.exact ? { urlFilter: `|https://${key.domain}/` } : { requestDomains: [key.domain] };

    const crossSite = applicable.filter((c) => c.sameSite !== 'strict');
    // Variante B: beliebiger Initiator, ohne Strict-Cookies.
    rules.push({
      priority: base + 1,
      condition: { tabIds: [tabId], resourceTypes, ...target },
      action: { type: 'modifyHeaders', requestHeaders: [requestHeader(crossSite)], responseHeaders: response },
    });
    // Variante A: nur nötig, wenn es Strict-Cookies gibt.
    if (crossSite.length !== applicable.length) {
      rules.push({
        priority: base + 2,
        condition: { tabIds: [tabId], resourceTypes, ...target, initiatorDomains: [siteOf(key.domain)] },
        action: { type: 'modifyHeaders', requestHeaders: [requestHeader(applicable)], responseHeaders: response },
      });
    }
  }
  return rules;
}
