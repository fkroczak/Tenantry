import { describe, expect, it } from 'vitest';
import { BACKUP_FORMAT, planImport } from '../src/background/backup';
import { compareVersions } from '../src/background/update';
import type { Container } from '../src/shared/types';

describe('compareVersions', () => {
  it('vergleicht MAJOR.MINOR.PATCH numerisch', () => {
    expect(compareVersions('0.4.10', '0.4.9')).toBeGreaterThan(0);
    expect(compareVersions('v0.5.0', '0.4.1')).toBeGreaterThan(0);
    expect(compareVersions('0.4.1', '0.4.1')).toBe(0);
    expect(compareVersions('0.4.0', '1.0.0')).toBeLessThan(0);
  });
});

describe('planImport', () => {
  const seeded: Container[] = [
    { id: 'cNEU1', name: 'Tenant A', color: 'blue', createdAt: 1 },
    { id: 'cNEU2', name: 'Tenant B', color: 'orange', createdAt: 2 },
  ];
  const file = {
    format: BACKUP_FORMAT,
    containers: [
      { id: 'cALT1', name: 'Tenant A', color: 'green', createdAt: 0 },
      { id: 'cALT3', name: 'Kunde Contoso', color: 'red', createdAt: 0 },
      { id: 'kaputt', name: '', color: 'red' },
      { id: 'x', name: 'Falsche Farbe', color: 'lila' },
    ],
  };

  it('nach Neuinstallation: gleichnamige Container übernehmen, neue ergänzen', () => {
    const p = planImport(seeded, file);
    expect(p.containers.map((c) => [c.id, c.name, c.color])).toEqual([
      ['cNEU1', 'Tenant A', 'green'],
      ['cNEU2', 'Tenant B', 'orange'],
      ['cALT3', 'Kunde Contoso', 'red'],
    ]);
    expect(p.idMap.get('cALT1')).toBe('cNEU1');
    expect(p.idMap.get('cALT3')).toBe('cALT3');
    expect(p).toMatchObject({ added: 1, updated: 1 });
  });

  it('erneuter Import ändert nichts', () => {
    const once = planImport(seeded, file).containers;
    expect(planImport(once, file)).toMatchObject({ added: 0, updated: 0 });
  });

  it('lehnt fremde Dateien ab', () => {
    expect(() => planImport(seeded, { format: 'tenantry-diagnose/1' })).toThrow(/Sicherung/);
  });
});
