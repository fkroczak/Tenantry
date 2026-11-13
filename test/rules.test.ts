import { describe, expect, it } from 'vitest';
import { buildTabRules, type RuleSpec } from '../src/background/rules';
import { parseSetCookie, type StoredCookie } from '../src/shared/cookies';
import { decodePayload } from '../src/shared/payload';
import { SCOPE_REQUEST_DOMAINS } from '../src/shared/scope';

const NOW = Date.UTC(2026, 0, 1);
const ck = (h: string, u: string) => parseSetCookie(h, new URL(u), NOW)!;

/** Simuliert die DNR-Auswahl: höchste Priorität unter den passenden Regeln. */
function pick(rules: RuleSpec[], reqUrl: string, initiator?: string): RuleSpec | undefined {
  const u = new URL(reqUrl);
  const match = (r: RuleSpec) => {
    const c = r.condition;
    if (c.urlFilter) {
      const host = c.urlFilter.slice('|https://'.length, -1);
      if (u.hostname !== host) return false;
    }
    if (c.requestDomains && !c.requestDomains.some((d) => u.hostname === d || u.hostname.endsWith('.' + d))) return false;
    if (c.initiatorDomains) {
      if (!initiator) return false;
      const ih = new URL(initiator).hostname;
      if (!c.initiatorDomains.some((d) => ih === d || ih.endsWith('.' + d))) return false;
    }
    return true;
  };
  return rules.filter(match).sort((a, b) => b.priority - a.priority)[0];
}

const cookieHeader = (r?: RuleSpec) => r?.action.requestHeaders[0];

describe('buildTabRules', () => {
  const cookies: StoredCookie[] = [
    ck('ESTSAUTH=e1; Secure; HttpOnly; SameSite=None', 'https://login.microsoftonline.com/'),
    ck('buid=b1; Domain=microsoftonline.com; Secure; SameSite=None', 'https://login.microsoftonline.com/'),
    ck('OpenIdConnect.token=t1; Secure; HttpOnly; Path=/', 'https://outlook.office.com/'),
    ck('ClientId=ci; Domain=office.com; Path=/', 'https://outlook.office.com/'),
    ck('strictOne=s; SameSite=Strict', 'https://admin.microsoft.com/'),
  ];
  const rules = buildTabRules({ tabId: 7, containerId: 'cA', cookies, scopeDomains: SCOPE_REQUEST_DOMAINS, now: NOW });

  it('bindet alle Regeln an den Tab und setzt main_frame', () => {
    for (const r of rules) {
      expect(r.condition.tabIds).toEqual([7]);
      expect(r.condition.resourceTypes).toContain('main_frame');
    }
  });

  it('liefert Host-only + übergeordnete Domain-Cookies für den exakten Host', () => {
    const h = cookieHeader(pick(rules, 'https://login.microsoftonline.com/common'));
    expect(h?.operation).toBe('set');
    expect(h?.value?.split('; ').sort()).toEqual(['ESTSAUTH=e1', 'buid=b1']);
  });

  it('gibt Host-only-Cookies NICHT an Subdomains weiter', () => {
    const h = cookieHeader(pick(rules, 'https://foo.outlook.office.com/'));
    expect(h?.value).toBe('ClientId=ci');
  });

  it('nutzt Domain-Cookies für unbekannte Subdomains', () => {
    expect(cookieHeader(pick(rules, 'https://www.office.com/'))?.value).toBe('ClientId=ci');
  });

  it('entfernt Cookies für Scope-Hosts ohne Container-Cookies', () => {
    const r = pick(rules, 'https://contoso.sharepoint.com/');
    expect(r?.priority).toBe(1);
    expect(cookieHeader(r)).toEqual({ header: 'cookie', operation: 'remove' });
  });

  it('SameSite=Strict nur bei Initiator derselben Site', () => {
    expect(cookieHeader(pick(rules, 'https://admin.microsoft.com/', 'https://admin.microsoft.com/'))?.value).toBe('strictOne=s');
    expect(cookieHeader(pick(rules, 'https://admin.microsoft.com/', 'https://evil.example/'))?.operation).toBe('remove');
  });

  it('Server-Timing enthält Container-ID und nur JS-sichtbare Cookies', () => {
    const r = pick(rules, 'https://outlook.office.com/mail/')!;
    const st = r.action.responseHeaders[0]!.value;
    const desc = /desc="([^"]+)"/.exec(st)![1]!;
    const p = decodePayload(desc)!;
    expect(p.c).toBe('cA');
    expect(p.k!.map((t) => t[0])).toEqual(['ClientId']);
  });

  it('ignoriert abgelaufene Cookies', () => {
    const expired = ck('old=1; Max-Age=1', 'https://outlook.office.com/');
    const r = buildTabRules({ tabId: 1, containerId: 'c', cookies: [expired], scopeDomains: SCOPE_REQUEST_DOMAINS, now: NOW + 5000 });
    expect(r).toHaveLength(1);
  });
});
