import { describe, expect, it } from 'vitest';
import manifest from '../static/manifest.json';

/** Chrome-Erweiterungs-ID aus dem öffentlichen Schlüssel (SHA-256, erste 16 Byte, Hex 0-f -> a-p). */
async function extensionId(keyB64: string): Promise<string> {
  const der = Uint8Array.from(atob(keyB64), (c) => c.charCodeAt(0));
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', der));
  const hex = [...hash.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

const TENANTRY_ID = 'lilkabchipnpplblekhiknflngomlmpk';

describe('Manifest-Schlüssel', () => {
  it('ergibt die feste Erweiterungs-ID (Daten bleiben beim Laden aus anderem Ordner erhalten)', async () => {
    expect(typeof manifest.key).toBe('string');
    expect(await extensionId(manifest.key)).toBe(TENANTRY_ID);
  });
});
