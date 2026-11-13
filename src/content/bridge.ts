/**
 * ISOLATED-World-Content-Script: Vermittler zwischen der Seite (MAIN-World)
 * und dem Service Worker. Die MAIN-World hat keinen Zugriff auf chrome.*.
 */
import type { CookieTuple } from '../shared/payload';
import type { CookiePush, HelloResponse } from '../shared/types';
import { TO_BRIDGE, TO_MAIN, type BridgeInbound, type MainInbound } from './protocol';

const host = location.hostname.toLowerCase();

/** Nur Cookies an die Seite geben, die zu diesem Frame-Host passen. */
function forThisHost(list: CookieTuple[] | undefined): CookieTuple[] {
  if (!host || !Array.isArray(list)) return [];
  return list.filter((t) => (t[3] ? host === t[2] : host === t[2] || host.endsWith('.' + t[2])));
}

function toMain(msg: MainInbound): void {
  window.dispatchEvent(new CustomEvent(TO_MAIN, { detail: JSON.stringify(msg) }));
}

async function hello(): Promise<void> {
  try {
    const res = (await chrome.runtime.sendMessage({ type: 'content:hello' })) as HelloResponse | null;
    if (!res || typeof res !== 'object') return;
    toMain({ type: 'ctx', cid: res.cid, cookies: forThisHost(res.cookies) });
  } catch {
    // Erweiterung neu geladen / Kontext ungültig -> nichts tun.
  }
}

window.addEventListener(TO_BRIDGE, (e) => {
  let msg: BridgeInbound;
  try {
    msg = JSON.parse(String((e as CustomEvent).detail)) as BridgeInbound;
  } catch {
    return;
  }
  if (msg.type === 'sync') void hello();
  else if (msg.type === 'setCookie' && typeof msg.cookie === 'string' && msg.cookie.length <= 8192) {
    chrome.runtime.sendMessage({ type: 'content:setCookie', cookie: msg.cookie }).catch(() => undefined);
  }
});

chrome.runtime.onMessage.addListener((msg: CookiePush) => {
  if (msg?.type === 'bg:cookies') toMain({ type: 'cookies', cid: msg.cid, cookies: forThisHost(msg.cookies) });
  return false;
});

void hello();
