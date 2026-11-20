/**
 * Update-Funktion.
 *
 * 1. Prüft regelmäßig das neueste GitHub-Release und meldet neue Versionen im
 *    Popup (und mit „↑“ am Symbol).
 * 2. Erkennt, dass die Dateien im Erweiterungsordner ersetzt wurden (z. B. durch
 *    Tenantry-Update.cmd), und lädt die Erweiterung dann selbst neu. Ein
 *    Neuladen behält chrome.storage.local (Container + dauerhafte Anmeldungen);
 *    nur ein Entfernen der Erweiterung löscht sie.
 */
import type { UpdateInfo } from '../shared/types';
import { warn } from './util';

export const RELEASES_API = 'https://api.github.com/repos/fkroczak/Tenantry/releases/latest';
export const RELEASES_PAGE = 'https://github.com/fkroczak/Tenantry/releases/latest';
const K_UPDATE = 'update:info';
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

/** Vergleicht MAJOR.MINOR.PATCH; >0 wenn a neuer ist als b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map((x) => parseInt(x, 10) || 0);
  const pb = b.replace(/^v/, '').split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

const running = (): string => chrome.runtime.getManifest().version;

export async function getUpdateInfo(): Promise<UpdateInfo> {
  const stored = (await chrome.storage.local.get(K_UPDATE))[K_UPDATE] as Partial<UpdateInfo> | undefined;
  const latest = stored?.latest ?? null;
  return {
    current: running(),
    latest,
    available: !!latest && compareVersions(latest, running()) > 0,
    pageUrl: stored?.pageUrl ?? RELEASES_PAGE,
    zipUrl: stored?.zipUrl ?? null,
    notes: stored?.notes ?? null,
    checkedAt: stored?.checkedAt ?? null,
    error: stored?.error ?? null,
  };
}

/** Fragt GitHub nach dem neuesten Release (höchstens alle 6 h, außer `force`). */
export async function checkForUpdate(force = false): Promise<UpdateInfo> {
  const prev = await getUpdateInfo();
  if (!force && prev.checkedAt && Date.now() - prev.checkedAt < CHECK_EVERY_MS) return prev;
  let next: Partial<UpdateInfo>;
  try {
    const res = await fetch(RELEASES_API, { headers: { accept: 'application/vnd.github+json' }, cache: 'no-store' });
    if (!res.ok) throw new Error(`GitHub antwortet mit ${res.status}`);
    const rel = (await res.json()) as {
      tag_name?: string;
      html_url?: string;
      body?: string;
      assets?: { name?: string; browser_download_url?: string }[];
    };
    const latest = String(rel.tag_name ?? '').replace(/^v/, '');
    if (!/^\d+\.\d+\.\d+$/.test(latest)) throw new Error('Unerwartete Antwort von GitHub');
    const zip = rel.assets?.find((a) => /^tenantry-.*\.zip$/.test(a.name ?? ''));
    next = {
      latest,
      pageUrl: rel.html_url ?? RELEASES_PAGE,
      zipUrl: zip?.browser_download_url ?? null,
      notes: typeof rel.body === 'string' ? rel.body.slice(0, 4000) : null,
      checkedAt: Date.now(),
      error: null,
    };
  } catch (e) {
    next = { ...prev, checkedAt: Date.now(), error: e instanceof Error ? e.message : String(e) };
  }
  await chrome.storage.local.set({ [K_UPDATE]: next });
  const info = await getUpdateInfo();
  await showUpdateBadge(info);
  return info;
}

/** Standard-Badge (gilt für Tabs ohne eigenen Container-Badge). */
export async function showUpdateBadge(info?: UpdateInfo): Promise<void> {
  const i = info ?? (await getUpdateInfo());
  await chrome.action.setBadgeText({ text: i.available ? '↑' : '' }).catch(() => undefined);
  if (i.available) await chrome.action.setBadgeBackgroundColor({ color: '#188038' }).catch(() => undefined);
}

/**
 * Version der Dateien im Erweiterungsordner. Bei entpackt geladenen
 * Erweiterungen liest Chrome Ressourcen direkt von der Festplatte.
 */
export async function versionOnDisk(): Promise<string | null> {
  try {
    const res = await fetch(chrome.runtime.getURL('manifest.json'), { cache: 'no-store' });
    const m = (await res.json()) as { version?: unknown };
    return typeof m.version === 'string' ? m.version : null;
  } catch {
    return null;
  }
}

/**
 * Lädt die Erweiterung neu, wenn im Ordner eine neuere Version liegt.
 * `beforeReload` sichert ausstehende Daten.
 */
export async function reloadIfUpdatedOnDisk(beforeReload: () => Promise<void>): Promise<boolean> {
  const disk = await versionOnDisk();
  if (!disk || compareVersions(disk, running()) <= 0) return false;
  try {
    await beforeReload();
  } catch (e) {
    warn('Sichern vor dem Neuladen fehlgeschlagen', e);
  }
  chrome.runtime.reload();
  return true;
}
