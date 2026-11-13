import { describe, expect, it } from 'vitest';
import manifest from '../static/manifest.json';
import { decodePayload, encodePayload, MAX_PAYLOAD_CHARS } from '../src/shared/payload';
import { COOKIE_APEX_PERMISSIONS, inScope, SCOPE_MATCH_PATTERNS, siteOf } from '../src/shared/scope';

describe('Scope', () => {
  it('erkennt die geforderten Domains', () => {
    for (const h of [
      'login.microsoftonline.com',
      'login.live.com',
      'outlook.office.com',
      'admin.microsoft.com',
      'entra.microsoft.com',
      'contoso.sharepoint.com',
      'portal.azure.com',
      'admin.cloud.microsoft',
    ]) expect(inScope(h), h).toBe(true);
    for (const h of ['example.com', 'evilmicrosoft.com', 'foo.login.microsoftonline.com', 'live.com']) {
      expect(inScope(h), h).toBe(false);
    }
  });

  it('siteOf', () => {
    expect(siteOf('outlook.office.com')).toBe('office.com');
    expect(siteOf('admin.cloud.microsoft')).toBe('cloud.microsoft');
  });

  it('Manifest-Host-Permissions und Content-Script-Matches entsprechen SCOPE', () => {
    const sorted = [...SCOPE_MATCH_PATTERNS].sort();
    expect([...manifest.host_permissions].sort()).toEqual([...sorted, ...COOKIE_APEX_PERMISSIONS].sort());
    for (const cs of manifest.content_scripts) expect([...cs.matches].sort()).toEqual(sorted);
  });
});

describe('Payload', () => {
  it('Roundtrip inkl. Unicode', () => {
    const p = { v: 1 as const, c: 'cX', k: [['n', 'wört', 'office.com', 0, '/', 1, 0, 1] as never] };
    expect(decodePayload(encodePayload(p))).toEqual(p);
  });

  it('lässt Cookies bei zu großer Payload weg', () => {
    const big = Array.from({ length: 400 }, (_, i) => [`n${i}`, 'x'.repeat(60), 'office.com', 0, '/', 1, 0, i] as never);
    const enc = encodePayload({ v: 1, c: 'cX', k: big });
    expect(enc.length).toBeLessThan(MAX_PAYLOAD_CHARS);
    expect(decodePayload(enc)).toEqual({ v: 1, c: 'cX' });
  });
});
