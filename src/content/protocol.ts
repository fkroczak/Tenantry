/** Ereignisnamen für die Kommunikation MAIN-World <-> ISOLATED-World (Bridge). */
export const TO_MAIN = 'tenantry:to-main';
export const TO_BRIDGE = 'tenantry:to-bridge';

import type { CookieTuple } from '../shared/payload';

export type MainInbound =
  | { type: 'ctx'; cid: string | null; cookies: CookieTuple[] }
  | { type: 'cookies'; cid: string; cookies: CookieTuple[] };

export type BridgeInbound = { type: 'sync' } | { type: 'setCookie'; cookie: string };
