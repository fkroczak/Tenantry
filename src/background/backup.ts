/**
 * Sicherung und Wiederherstellung der Container.
 *
 * chrome.storage.local überlebt Updates und das Neuladen der Erweiterung, wird
 * aber gelöscht, wenn die Erweiterung entfernt wird. Die Sicherung ist eine
 * Datei, die der Benutzer selbst aufbewahrt:
 *   - immer: Container (ID, Name, Farbe)
 *   - optional: Anmeldungen (Cookies) – enthalten Zugangstoken!
 */
import type { StoredCookie } from '../shared/cookies';
import { isExpired } from '../shared/cookies';
import type { BackupResult, Container } from '../shared/types';
import { applyCookies, flush, listCookies } from './jar';
import { isValidColor, saveContainers, state } from './state';

export const BACKUP_FORMAT = 'tenantry-backup/1';
const K_LAST = 'backup:last';

interface BackupFile {
  format: typeof BACKUP_FORMAT;
  exportedAt: string;
  version: string;
  containers: Container[];
  cookies?: Record<string, StoredCookie[]>;
}

export async function exportBackup(includeCookies: boolean): Promise<string> {
  const file: BackupFile = {
    format: BACKUP_FORMAT,
    exportedAt: new Date().toISOString(),
    version: chrome.runtime.getManifest().version,
    containers: state.containers.map(({ id, name, color, createdAt }) => ({ id, name, color, createdAt })),
  };
  if (includeCookies) {
    file.cookies = Object.fromEntries(state.containers.map((c) => [c.id, listCookies(c.id)]));
  }
  await chrome.storage.local.set({ [K_LAST]: Date.now() });
  return JSON.stringify(file, null, 1);
}

export async function lastBackupAt(): Promise<number | null> {
  const v = (await chrome.storage.local.get(K_LAST))[K_LAST];
  return typeof v === 'number' ? v : null;
}

function isCookie(c: unknown): c is StoredCookie {
  const x = c as Record<string, unknown>;
  return (
    !!x &&
    typeof x.name === 'string' &&
    typeof x.value === 'string' &&
    typeof x.domain === 'string' &&
    typeof x.path === 'string' &&
    typeof x.hostOnly === 'boolean' &&
    typeof x.secure === 'boolean' &&
    typeof x.httpOnly === 'boolean' &&
    typeof x.created === 'number' &&
    (x.expires === null || typeof x.expires === 'number')
  );
}

/** Ergebnis einer Wiederherstellung, rein berechnet (testbar). */
export function planImport(
  current: Container[],
  raw: unknown,
): { containers: Container[]; idMap: Map<string, string>; added: number; updated: number } {
  const file = raw as Partial<BackupFile>;
  if (!file || file.format !== BACKUP_FORMAT || !Array.isArray(file.containers)) {
    throw new Error('Keine gültige Tenantry-Sicherung.');
  }
  const containers = current.map((c) => ({ ...c }));
  const idMap = new Map<string, string>();
  let added = 0;
  let updated = 0;
  for (const b of file.containers) {
    if (!b || typeof b.id !== 'string' || typeof b.name !== 'string' || !isValidColor(b.color)) continue;
    const name = b.name.trim().slice(0, 40);
    if (!name) continue;
    const sameId = containers.find((c) => c.id === b.id);
    const sameName = containers.find((c) => c.name.toLowerCase() === name.toLowerCase());
    const target = sameId ?? sameName;
    if (target) {
      if (target.name !== name || target.color !== b.color) updated++;
      if (!sameName || sameName === target) target.name = name;
      target.color = b.color;
      idMap.set(b.id, target.id);
    } else {
      containers.push({ id: b.id, name, color: b.color, createdAt: typeof b.createdAt === 'number' ? b.createdAt : Date.now() });
      idMap.set(b.id, b.id);
      added++;
    }
  }
  return { containers, idMap, added, updated };
}

export async function importBackup(json: string): Promise<{ result: BackupResult; changedCids: string[] }> {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error('Datei ist kein gültiges JSON.');
  }
  const plan = planImport(state.containers, raw);
  state.containers = plan.containers;
  await saveContainers();

  const changedCids: string[] = [];
  let cookies = 0;
  const now = Date.now();
  const byCid = (raw as BackupFile).cookies;
  if (byCid && typeof byCid === 'object') {
    for (const [bid, list] of Object.entries(byCid)) {
      const cid = plan.idMap.get(bid);
      if (!cid || !Array.isArray(list)) continue;
      const valid = list.filter(isCookie).filter((c) => !isExpired(c, now));
      if (valid.length && applyCookies(cid, valid)) changedCids.push(cid);
      cookies += valid.length;
    }
    await flush();
  }
  return { result: { added: plan.added, updated: plan.updated, cookies }, changedCids };
}
