import { describe, expect, it } from 'vitest';
import { parseSetCookie } from '../src/shared/cookies';
import {
  compareWithJar,
  fingerprint,
  redactUrl,
  summarizeCookieHeader,
  summarizeFormData,
  summarizeSetCookie,
} from '../src/background/diagFormat';

const SECRET = 'eyJ0eXAiOiJKV1QiLCJhbGciOi.SUPERGEHEIM';

describe('fingerprint', () => {
  it('ist stabil, kurz und enthält den Wert nicht', () => {
    expect(fingerprint(SECRET)).toBe(fingerprint(SECRET));
    expect(fingerprint(SECRET)).toMatch(/^\d+:[0-9a-f]{6}$/);
    expect(fingerprint(SECRET)).not.toBe(fingerprint(SECRET + 'x'));
  });
});

describe('redactUrl', () => {
  it('behält unkritische Parameter, ersetzt andere durch die Länge', () => {
    const u = redactUrl(
      'https://login.microsoftonline.com/t/oauth2/authorize?client_id=00000003-0000-0ff1-ce00-000000000000&response_mode=form_post&state=abc123&ear_jwe_crypto=xyz#frag',
    );
    expect(u).toBe(
      'https://login.microsoftonline.com/t/oauth2/authorize?client_id=00000003-0000-0ff1-ce00-000000000000&response_mode=form_post&state=<6>&ear_jwe_crypto=<3>',
    );
    expect(redactUrl(undefined)).toBe('');
  });
});

describe('Cookies ohne Werte', () => {
  it('Cookie-Header -> Namen + Fingerabdruck', () => {
    const s = summarizeCookieHeader(`ESTSAUTH=${SECRET}; buid=1`);
    expect(s).toEqual([`ESTSAUTH=${fingerprint(SECRET)}`, `buid=${fingerprint('1')}`]);
    expect(s.join()).not.toContain('GEHEIM');
  });

  it('Set-Cookie -> Attribute ohne Wert', () => {
    const s = summarizeSetCookie(`FedAuth=${SECRET}; path=/; SameSite=None; secure; HttpOnly`);
    expect(s).toBe(`FedAuth=${fingerprint(SECRET)}; path=/; SameSite=None; secure; HttpOnly`);
    expect(summarizeSetCookie('a=b; foo=bar')).toBe(`a=${fingerprint('b')}; foo=<…>`);
  });

  it('Formularfelder nur mit Länge', () => {
    expect(summarizeFormData({ code: [SECRET], state: ['x'] })).toEqual([`code=<${SECRET.length}>`, 'state=<1>']);
    expect(summarizeFormData(undefined)).toBeUndefined();
  });
});

describe('compareWithJar', () => {
  const T = Date.UTC(2026, 0, 1);
  const url = 'https://login.microsoftonline.com/common/login';
  const jar = [
    parseSetCookie('ESTSAUTH=neu; Path=/; Secure; HttpOnly; SameSite=None', new URL(url), T)!,
    parseSetCookie('buid=1; Path=/; Secure; HttpOnly; SameSite=None', new URL(url), T)!,
  ];
  it('erkennt fehlende, abweichende und unbekannte Cookies', () => {
    expect(compareWithJar(jar, url, 'ESTSAUTH=alt; fremd=1', T + 1)).toEqual({
      missing: ['buid'],
      differs: ['ESTSAUTH'],
      unknown: ['fremd'],
    });
    expect(compareWithJar(jar, url, 'ESTSAUTH=neu; buid=1', T + 1)).toEqual({ missing: [], differs: [], unknown: [] });
  });
});
