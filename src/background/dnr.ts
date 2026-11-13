/**
 * Verwaltet die declarativeNetRequest-Session-Rules aller Container-Tabs.
 * Session-Rules überleben Neustarts des Service Workers, nicht aber
 * Browser-Neustarts oder ein Neuladen der Erweiterung.
 */
import { SCOPE_REQUEST_DOMAINS } from '../shared/scope';
import { listCookies } from './jar';
import { buildTabRules } from './rules';
import { state } from './state';
import { warn } from './util';

type Rule = chrome.declarativeNetRequest.Rule;

const tabRuleIds = new Map<number, number[]>();
let nextId = 1;
const dirty = new Set<number>();
let chain: Promise<void> = Promise.resolve();

/** Liest vorhandene Regeln ein (nach SW-Neustart) und entfernt verwaiste. */
export async function initDnr(resetAll: boolean): Promise<void> {
  const rules = await chrome.declarativeNetRequest.getSessionRules();
  const remove: number[] = [];
  for (const r of rules) {
    const tabId = r.condition.tabIds?.[0];
    if (resetAll || tabId === undefined || !state.tabs.has(tabId)) {
      remove.push(r.id);
      continue;
    }
    const list = tabRuleIds.get(tabId) ?? [];
    list.push(r.id);
    tabRuleIds.set(tabId, list);
    nextId = Math.max(nextId, r.id + 1);
  }
  if (remove.length) await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: remove });
}

export function hasRules(tabId: number): boolean {
  return (tabRuleIds.get(tabId)?.length ?? 0) > 0;
}

/**
 * Markiert Tabs als neu zu berechnen. Aufrufe werden gebündelt und
 * nacheinander ausgeführt; das Promise löst auf, sobald die Regeln aktiv sind.
 */
export function syncTabs(tabIds: Iterable<number>): Promise<void> {
  for (const t of tabIds) dirty.add(t);
  chain = chain.then(flushDirty, flushDirty);
  return chain;
}

function allocId(): number {
  if (nextId > 2_000_000_000) nextId = 1;
  const used = new Set([...tabRuleIds.values()].flat());
  while (used.has(nextId)) nextId++;
  return nextId++;
}

async function flushDirty(): Promise<void> {
  if (!dirty.size) return;
  const batch = [...dirty];
  dirty.clear();
  const now = Date.now();
  const removeRuleIds: number[] = [];
  const addRules: Rule[] = [];
  const nextMap = new Map<number, number[]>();

  for (const tabId of batch) {
    removeRuleIds.push(...(tabRuleIds.get(tabId) ?? []));
    const cid = state.tabs.get(tabId);
    if (!cid) {
      nextMap.set(tabId, []);
      continue;
    }
    const specs = buildTabRules({
      tabId,
      containerId: cid,
      cookies: listCookies(cid, now),
      scopeDomains: SCOPE_REQUEST_DOMAINS,
      now,
    });
    const ids: number[] = [];
    for (const spec of specs) {
      const id = allocId();
      ids.push(id);
      addRules.push({ id, ...spec } as unknown as Rule);
    }
    nextMap.set(tabId, ids);
    // IDs sofort reservieren, damit allocId sie nicht doppelt vergibt.
    tabRuleIds.set(tabId, [...(tabRuleIds.get(tabId) ?? []), ...ids]);
  }

  try {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds, addRules });
    for (const [tabId, ids] of nextMap) {
      if (ids.length) tabRuleIds.set(tabId, ids);
      else tabRuleIds.delete(tabId);
    }
  } catch (e) {
    warn('updateSessionRules fehlgeschlagen', e);
    // Zustand zurücksetzen: alte Regeln sind evtl. noch aktiv.
    for (const [tabId, ids] of nextMap) {
      const prev = (tabRuleIds.get(tabId) ?? []).filter((id) => !ids.includes(id));
      if (prev.length) tabRuleIds.set(tabId, prev);
      else tabRuleIds.delete(tabId);
    }
    void chrome.action.setBadgeText({ text: '!' });
    void chrome.action.setTitle({ title: `Tenantry – Fehler beim Setzen der Regeln: ${String(e)}` });
  }
}
