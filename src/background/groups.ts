/**
 * Darstellung der Container als Chrome-Tab-Gruppen.
 * Pro Container und Fenster gibt es höchstens eine Gruppe.
 */
import type { Container } from '../shared/types';
import { containerById, containerOfTab, saveGroups, state } from './state';
import { retry, serialQueue, warn } from './util';

const run = serialQueue();

function groupProps(c: Container): chrome.tabGroups.UpdateProperties {
  return { title: c.name, color: c.color as chrome.tabGroups.UpdateProperties['color'] };
}

async function findGroup(c: Container, windowId: number): Promise<number | null> {
  for (const [gid, cid] of state.groups) {
    if (cid !== c.id) continue;
    try {
      const g = await chrome.tabGroups.get(gid);
      if (g.windowId === windowId) return gid;
    } catch {
      state.groups.delete(gid);
    }
  }
  return null;
}

/** Fügt den Tab der Gruppe seines Containers hinzu (legt sie bei Bedarf an). */
export function ensureGrouped(tabId: number): Promise<void> {
  return run(async () => {
    const c = containerOfTab(tabId);
    if (!c) return;
    let tab: chrome.tabs.Tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      return;
    }
    const win = await chrome.windows.get(tab.windowId);
    if (win.type !== 'normal') return; // Popups (z. B. MSAL-Login) lassen sich nicht gruppieren.

    let gid = await findGroup(c, tab.windowId);
    if (gid !== null && tab.groupId === gid) return;
    try {
      if (gid === null) {
        gid = await retry(() => chrome.tabs.group({ tabIds: [tabId], createProperties: { windowId: tab.windowId } }));
        await chrome.tabGroups.update(gid, groupProps(c));
      } else {
        const target = gid;
        await retry(() => chrome.tabs.group({ tabIds: [tabId], groupId: target }));
      }
      state.groups.set(gid, c.id);
      await saveGroups();
    } catch (e) {
      warn('Gruppieren fehlgeschlagen', tabId, e);
    }
  });
}

/** Titel/Farbe aller Gruppen eines Containers aktualisieren. */
export function refreshGroups(cid: string): Promise<void> {
  return run(async () => {
    const c = containerById(cid);
    if (!c) return;
    for (const [gid, gcid] of state.groups) {
      if (gcid !== cid) continue;
      await chrome.tabGroups.update(gid, groupProps(c)).catch(() => state.groups.delete(gid));
    }
    await saveGroups();
  });
}

/** Stellt Titel/Farbe wieder her, falls der Benutzer die Gruppe umbenannt hat. */
export function enforceGroupLook(group: chrome.tabGroups.TabGroup): void {
  const c = containerById(state.groups.get(group.id));
  if (!c) return;
  if (group.title !== c.name || group.color !== c.color) {
    void run(() => chrome.tabGroups.update(group.id, groupProps(c)).then(() => undefined, () => undefined));
  }
}

export function ungroup(tabIds: number[]): Promise<void> {
  return run(async () => {
    if (tabIds.length) await retry(() => chrome.tabs.ungroup(tabIds as [number, ...number[]])).catch((e) => warn('Ungroup fehlgeschlagen', e));
  });
}

/**
 * Nach Browser-Neustart / Neuladen der Erweiterung: Tab-Gruppen anhand ihres
 * Titels wieder den Containern zuordnen. Gibt die zugeordneten Tabs zurück.
 */
export async function recoverFromGroups(): Promise<Map<number, string>> {
  const assigned = new Map<number, string>();
  const groups = await chrome.tabGroups.query({});
  for (const g of groups) {
    const c = state.containers.find((x) => x.name === g.title);
    if (!c) continue;
    state.groups.set(g.id, c.id);
    const tabs = await chrome.tabs.query({ groupId: g.id });
    for (const t of tabs) if (t.id !== undefined) assigned.set(t.id, c.id);
  }
  await saveGroups();
  return assigned;
}
