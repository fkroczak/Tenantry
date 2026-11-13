/**
 * Zentraler Zustand des Service Workers.
 *
 * - Container (dauerhaft)        -> chrome.storage.local  "containers"
 * - Tab -> Container             -> chrome.storage.session "tabMap"
 * - Tab-Gruppe -> Container      -> chrome.storage.session "groupMap"
 *
 * Tab-/Gruppen-IDs sind nur innerhalb einer Browser-Sitzung gültig. Nach einem
 * Neustart wird die Zuordnung über die Titel der Tab-Gruppen rekonstruiert
 * (siehe groups.ts -> recoverFromGroups).
 */
import { TAB_GROUP_COLORS, type Container, type ContainerColor } from '../shared/types';
import { randomId } from './util';

const K_CONTAINERS = 'containers';
const K_TABS = 'tabMap';
const K_GROUPS = 'groupMap';
const K_BOOTED = 'booted';

export const state = {
  containers: [] as Container[],
  tabs: new Map<number, string>(),
  groups: new Map<number, string>(),
};

export async function loadState(): Promise<{ fresh: boolean; seeded: boolean }> {
  const local = await chrome.storage.local.get(K_CONTAINERS);
  let seeded = false;
  if (!Array.isArray(local[K_CONTAINERS])) {
    // Erster Start: zwei Beispiel-Container für den Test anlegen.
    const now = Date.now();
    state.containers = [
      { id: randomId('c'), name: 'Tenant A', color: 'blue', createdAt: now },
      { id: randomId('c'), name: 'Tenant B', color: 'orange', createdAt: now + 1 },
    ];
    await saveContainers();
    seeded = true;
  } else {
    state.containers = local[K_CONTAINERS] as Container[];
  }

  const sess = await chrome.storage.session.get([K_TABS, K_GROUPS, K_BOOTED]);
  state.tabs = toNumMap(sess[K_TABS]);
  state.groups = toNumMap(sess[K_GROUPS]);
  return { fresh: !sess[K_BOOTED], seeded };
}

function toNumMap(o: unknown): Map<number, string> {
  const m = new Map<number, string>();
  if (o && typeof o === 'object') {
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      if (typeof v === 'string') m.set(Number(k), v);
    }
  }
  return m;
}

export async function markBooted(): Promise<void> {
  await chrome.storage.session.set({ [K_BOOTED]: true });
}

export async function saveContainers(): Promise<void> {
  await chrome.storage.local.set({ [K_CONTAINERS]: state.containers });
}

export async function saveTabs(): Promise<void> {
  await chrome.storage.session.set({ [K_TABS]: Object.fromEntries(state.tabs) });
}

export async function saveGroups(): Promise<void> {
  await chrome.storage.session.set({ [K_GROUPS]: Object.fromEntries(state.groups) });
}

export function containerById(id: string | undefined | null): Container | undefined {
  return id ? state.containers.find((c) => c.id === id) : undefined;
}

export function containerOfTab(tabId: number): Container | undefined {
  return containerById(state.tabs.get(tabId));
}

export function tabsOf(cid: string): number[] {
  return [...state.tabs].filter(([, c]) => c === cid).map(([t]) => t);
}

export function isValidColor(c: unknown): c is ContainerColor {
  return typeof c === 'string' && (TAB_GROUP_COLORS as readonly string[]).includes(c);
}

export function validateName(name: unknown, exceptId?: string): string {
  if (typeof name !== 'string') throw new Error('Name fehlt.');
  const n = name.trim().replace(/\s+/g, ' ');
  if (!n) throw new Error('Name darf nicht leer sein.');
  if (n.length > 40) throw new Error('Name ist zu lang (max. 40 Zeichen).');
  if (state.containers.some((c) => c.id !== exceptId && c.name.toLowerCase() === n.toLowerCase())) {
    throw new Error(`Ein Container namens „${n}“ existiert bereits.`);
  }
  return n;
}
