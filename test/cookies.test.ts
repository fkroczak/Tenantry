import { describe, expect, it } from 'vitest';
import {
  applyCookie,
  cookieMatchesUrl,
  defaultPath,
  parseSetCookie,
  pathMatch,
  serializeCookies,
  type StoredCookie,
} from '../src/shared/cookies';

const NOW = Date.UTC(2026, 0, 1);
const url = (u: string) => new URL(u);

describe('parseSetCookie', () => {
  it('parst Host-only-Cookies mit Attributen', () => {
    const c = parseSetCookie(
      'ESTSAUTH=abc; path=/; secure; HttpOnly; SameSite=None',
      url('https://login.microsoftonline.com/common/oauth2'),
      NOW,
    )!;
    expect(c).toMatchObject({
      name: 'ESTSAUTH',
      value: 'abc',
      domain: 'login.microsoftonline.com',
      hostOnly: true,
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'none',
      expires: null,
    });
  });

  it('akzeptiert Domain-Attribut für übergeordnete Domain', () => {
    const c = parseSetCookie('x=1; Domain=.office.com', url('https://outlook.office.com/mail/'), NOW)!;
    expect(c.domain).toBe('office.com');
    expect(c.hostOnly).toBe(false);
    expect(c.path).toBe('/mail');
  });

  it('verwirft fremde Domains und TLD-Cookies', () => {
    expect(parseSetCookie('x=1; Domain=sharepoint.com', url('https://outlook.office.com/'), NOW)).toBeNull();
    expect(parseSetCookie('x=1; Domain=com', url('https://outlook.office.com/'), NOW)).toBeNull();
  });

  it('Max-Age hat Vorrang vor Expires, <=0 bedeutet löschen', () => {
    const c = parseSetCookie('a=1; Expires=Wed, 21 Oct 2099 07:28:00 GMT; Max-Age=60', url('https://a.office.com/'), NOW)!;
    expect(c.expires).toBe(NOW + 60_000);
    const d = parseSetCookie('a=; Max-Age=0', url('https://a.office.com/'), NOW)!;
    expect(d.expires! <= NOW).toBe(true);
  });

  it('begrenzt die Laufzeit auf 400 Tage', () => {
    const c = parseSetCookie('a=1; Max-Age=999999999', url('https://a.office.com/'), NOW)!;
    expect(c.expires).toBe(NOW + 400 * 86400_000);
  });

  it('verbietet HttpOnly aus document.cookie', () => {
    expect(parseSetCookie('a=1; HttpOnly', url('https://a.office.com/'), NOW, { fromScript: true })).toBeNull();
  });

  it('prüft Cookie-Präfixe', () => {
    expect(parseSetCookie('__Host-a=1; Path=/', url('https://a.office.com/'), NOW)).toBeNull();
    expect(parseSetCookie('__Host-a=1; Secure; Path=/', url('https://a.office.com/'), NOW)).not.toBeNull();
    expect(parseSetCookie('__Host-a=1; Secure; Path=/; Domain=office.com', url('https://a.office.com/'), NOW)).toBeNull();
    expect(parseSetCookie('__Secure-a=1', url('https://a.office.com/'), NOW)).toBeNull();
  });
});

describe('Matching', () => {
  it('defaultPath / pathMatch nach RFC 6265', () => {
    expect(defaultPath('/a/b/c')).toBe('/a/b');
    expect(defaultPath('/a')).toBe('/');
    expect(pathMatch('/mail/inbox', '/mail')).toBe(true);
    expect(pathMatch('/mailbox', '/mail')).toBe(false);
    expect(pathMatch('/mail/', '/mail/')).toBe(true);
  });

  it('cookieMatchesUrl berücksichtigt hostOnly', () => {
    const host = parseSetCookie('a=1', url('https://office.com/'), NOW)!;
    const dom = parseSetCookie('b=1; Domain=office.com', url('https://office.com/'), NOW)!;
    const sub = { hostname: 'outlook.office.com', pathname: '/', protocol: 'https:' };
    expect(cookieMatchesUrl(host, sub)).toBe(false);
    expect(cookieMatchesUrl(dom, sub)).toBe(true);
  });
});

describe('applyCookie / serialize', () => {
  it('überschreibt, löscht und schützt HttpOnly vor Scripts', () => {
    const jar = new Map<string, StoredCookie>();
    const u = url('https://a.office.com/');
    expect(applyCookie(jar, parseSetCookie('a=1; HttpOnly', u, NOW)!, NOW)).toBe(true);
    expect(applyCookie(jar, parseSetCookie('a=2', u, NOW)!, NOW, { fromScript: true })).toBe(false);
    expect(applyCookie(jar, parseSetCookie('a=1; HttpOnly', u, NOW)!, NOW)).toBe(false); // unverändert
    expect(applyCookie(jar, parseSetCookie('a=; Max-Age=0', u, NOW)!, NOW)).toBe(true);
    expect(jar.size).toBe(0);
  });

  it('sortiert längere Pfade zuerst', () => {
    const a = parseSetCookie('a=1; Path=/', url('https://x.office.com/'), NOW)!;
    const b = parseSetCookie('b=2; Path=/mail', url('https://x.office.com/'), NOW + 1)!;
    expect(serializeCookies([a, b])).toBe('b=2; a=1');
  });
});
