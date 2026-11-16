import { describe, expect, it } from 'vitest';
import { parseSetCookie } from '../src/shared/cookies';
import { missingCookies, parseCookieHeader, RetryLimiter } from '../src/background/stale';

const T = Date.UTC(2026, 0, 1);
const ck = (h: string, u: string, at = T) => parseSetCookie(h, new URL(u), at)!;
const SP = 'https://contoso-admin.sharepoint.com/_layouts/15/online/AdminHome.aspx';

describe('parseCookieHeader', () => {
  it('zerlegt den Header', () => {
    const m = parseCookieHeader('a=1; b=2; a=3');
    expect([...m.get('a')!]).toEqual(['1', '3']);
    expect([...m.get('b')!]).toEqual(['2']);
    expect(parseCookieHeader(undefined).size).toBe(0);
  });
});

describe('missingCookies', () => {
  const fed = ck('FedAuth=x; Path=/; Secure; HttpOnly; SameSite=None', 'https://contoso-admin.sharepoint.com/_forms/default.aspx');
  const rtfa = ck('rtFa=y; Domain=sharepoint.com; Path=/; Secure; HttpOnly; SameSite=None', 'https://contoso-admin.sharepoint.com/_forms/default.aspx');

  it('meldet fehlende Cookies nach einem 302 (SharePoint FedAuth)', () => {
    expect(missingCookies([fed, rtfa], SP, undefined, T + 5)).toEqual(['FedAuth', 'rtFa']);
    expect(missingCookies([fed, rtfa], SP, 'rtFa=y', T + 5)).toEqual(['FedAuth']);
  });

  it('nichts fehlt, wenn alle Cookies gesendet wurden', () => {
    expect(missingCookies([fed, rtfa], SP, 'FedAuth=x; rtFa=y', T + 5)).toEqual([]);
  });

  it('erkennt veraltete Werte', () => {
    expect(missingCookies([fed], SP, 'FedAuth=alt', T + 5)).toEqual(['FedAuth']);
  });

  it('ignoriert Cookies, die erst nach dem Senden gespeichert wurden', () => {
    expect(missingCookies([fed], SP, undefined, T - 1)).toEqual([]);
  });

  it('ignoriert fremde Hosts, Strict und abgelaufene Cookies', () => {
    const other = ck('FedAuth=z; Path=/; Secure', 'https://fabrikam.sharepoint.com/');
    const strict = ck('s=1; Path=/; Secure; SameSite=Strict', SP);
    const old = ck('o=1; Path=/; Secure; Max-Age=1', SP);
    expect(missingCookies([other, strict, old], SP, undefined, T + 5000)).toEqual([]);
  });
});

describe('RetryLimiter', () => {
  it('begrenzt Wiederholungen pro Tab und Zeitfenster', () => {
    const l = new RetryLimiter(2, 1000);
    expect(l.allow(1, 0)).toBe(true);
    expect(l.allow(1, 10)).toBe(true);
    expect(l.allow(1, 20)).toBe(false);
    expect(l.allow(2, 20)).toBe(true);
    expect(l.allow(1, 1500)).toBe(true);
  });
});
