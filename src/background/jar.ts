/**
 * Cookie-Speicher pro Container.
 *
 * Persistente Cookies -> chrome.storage.local   "jar:<cid>"
 * Session-Cookies     -> chrome.storage.session "sjar:<cid>"  (verfallen mit dem Browser)
 */
import { applyCookie, cookieKey, isExpired, type ParseOptions, type StoredCookie } from '../shared/cookies';

const jars = new Map<string, Map<string, StoredCookie>>();
const dirty = new Set<string>();
let saveTimer: ReturnType<typeof setTimeout> | null = null;

export async function loadJars(cids: string[]): Promise<void> {
  if (!cids.length) return;
  const localKeys = cids.map((c) => 'jar:' + c);
  const sessKeys = cids.map((c) => 'sjar:' + c);
  const [local, sess] = await Promise.all([chrome.storage.local.get(localKeys), chrome.storage.session.get(sessKeys)]);
  const now = Date.now();
  for (const cid of cids) {
    const m = new Map<string, StoredCookie>();
    for (const list of [local['jar:' + cid], sess['sjar:' + cid]]) {
      if (!Array.isArray(list)) continue;
      for (const c of list as StoredCookie[]) if (!isExpired(c, now)) m.set(cookieKey(c), c);
    }
    jars.set(cid, m);
  }
}

function jarOf(cid: string): Map<string, StoredCookie> {
  let m = jars.get(cid);
  if (!m) {
    m = new Map();
    jars.set(cid, m);
  }
  return m;
}

export function listCookies(cid: string, now = Date.now()): StoredCookie[] {
  return [...jarOf(cid).values()].filter((c) => !isExpired(c, now));
}

/** Gibt true zurück, wenn sich der Speicher geändert hat. */
export function applyCookies(cid: string, cookies: StoredCookie[], opts: ParseOptions = {}): boolean {
  const jar = jarOf(cid);
  const now = Date.now();
  let changed = false;
  for (const c of cookies) changed = applyCookie(jar, c, now, opts) || changed;
  if (changed) scheduleSave(cid);
  return changed;
}

export function purgeExpired(now = Date.now()): string[] {
  const changed: string[] = [];
  for (const [cid, jar] of jars) {
    let any = false;
    for (const [k, c] of jar) {
      if (isExpired(c, now)) {
        jar.delete(k);
        any = true;
      }
    }
    if (any) {
      changed.push(cid);
      scheduleSave(cid);
    }
  }
  return changed;
}

export async function deleteJar(cid: string): Promise<void> {
  jars.delete(cid);
  dirty.delete(cid);
  await Promise.all([chrome.storage.local.remove('jar:' + cid), chrome.storage.session.remove('sjar:' + cid)]);
}

export async function clearJar(cid: string): Promise<void> {
  jars.set(cid, new Map());
  dirty.add(cid);
  await flush();
}

function scheduleSave(cid: string): void {
  dirty.add(cid);
  if (saveTimer) return;
  saveTimer = setTimeout(() => void flush(), 250);
}

export async function flush(): Promise<void> {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  const cids = [...dirty];
  dirty.clear();
  const local: Record<string, StoredCookie[]> = {};
  const sess: Record<string, StoredCookie[]> = {};
  for (const cid of cids) {
    const all = [...jarOf(cid).values()];
    local['jar:' + cid] = all.filter((c) => c.expires !== null);
    sess['sjar:' + cid] = all.filter((c) => c.expires === null);
  }
  if (cids.length) await Promise.all([chrome.storage.local.set(local), chrome.storage.session.set(sess)]);
}
