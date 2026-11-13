/**
 * MAIN-World-Content-Script (run_at: document_start).
 *
 * Läuft VOR allen Seiten-Scripts und isoliert pro Container:
 *   - document.cookie            -> Container-Cookie-Speicher (via Bridge)
 *   - localStorage/sessionStorage -> Schlüssel-Präfix  "__tnty:<cid>:"
 *   - IndexedDB, CacheStorage, BroadcastChannel, Web Locks, SharedWorker
 *                                 -> Namens-Präfix "tenantry:<cid>:"
 *   - Service-Worker-Registrierung -> blockiert (Requests eines Service
 *     Workers haben keine tabId und wären nicht isolierbar)
 *
 * Der Container wird SYNCHRON ermittelt, damit MSAL beim Start bereits den
 * isolierten Speicher sieht:
 *   1. about:blank-Frames: Kontext des (gleich-originigen) Elternfensters
 *   2. Server-Timing-Header der Navigation (von DNR-Regeln gesetzt)
 *   3. Markierung im nativen sessionStorage (vorheriger Seitenaufruf im Tab)
 * Danach bestätigt die Bridge den Container asynchron; bei Abweichung wird
 * die Seite einmalig neu geladen.
 *
 * Hinweis: Das ist eine Trennung gegen versehentliche Vermischung, KEINE
 * Sicherheitsgrenze gegen bösartige Scripts derselben Origin.
 */
import {
  applyCookie,
  cookieKey,
  cookieMatchesUrl,
  isExpired,
  parseSetCookie,
  serializeCookies,
  type StoredCookie,
} from '../shared/cookies';
import { decodePayload, fromTuple, SERVER_TIMING_NAME, type CookieTuple } from '../shared/payload';
import { TO_BRIDGE, TO_MAIN, type BridgeInbound, type MainInbound } from './protocol';

type Source = 'parent' | 'server-timing' | 'marker';
interface Ctx {
  cid: string;
  cookies: StoredCookie[] | null;
  source: Source;
}

const CTX_SYMBOL = Symbol.for('tenantry.ctx');
const INSTALLED = Symbol.for('tenantry.installed');
const MARKER_KEY = '__tenantry_ctx__';
const RELOAD_KEY = '__tenantry_reloads__';

const w = window as unknown as Record<PropertyKey, unknown>;

// Native Storage-Objekte VOR dem Überschreiben sichern.
const nativeLocal = safe(() => window.localStorage);
const nativeSession = safe(() => window.sessionStorage);

function safe<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

function toBridge(msg: BridgeInbound): void {
  window.dispatchEvent(new CustomEvent(TO_BRIDGE, { detail: JSON.stringify(msg) }));
}

// ---------------------------------------------------------------------------
// Kontext ermitteln
// ---------------------------------------------------------------------------

function fromParent(): Ctx | null {
  if (location.protocol !== 'about:' || window.parent === window) return null;
  const p = safe(() => (window.parent as unknown as Record<PropertyKey, unknown>)[CTX_SYMBOL]) as { cid?: string } | null;
  return p?.cid ? { cid: p.cid, cookies: null, source: 'parent' } : null;
}

function fromServerTiming(): Ctx | null {
  const nav = safe(() => performance.getEntriesByType('navigation')[0]) as PerformanceNavigationTiming | null;
  for (const st of nav?.serverTiming ?? []) {
    if (st.name !== SERVER_TIMING_NAME) continue;
    const p = decodePayload(st.description);
    if (p) return { cid: p.c, cookies: p.k ? p.k.map(fromTuple) : null, source: 'server-timing' };
  }
  return null;
}

function fromMarker(): Ctx | null {
  const cid = safe(() => nativeSession?.getItem(MARKER_KEY));
  return cid ? { cid, cookies: null, source: 'marker' } : null;
}

function setMarker(cid: string | null): void {
  safe(() => (cid ? nativeSession?.setItem(MARKER_KEY, cid) : nativeSession?.removeItem(MARKER_KEY)));
}

/** Höchstens 2 automatische Reloads pro Minute (Schutz vor Schleifen). */
function reloadOnce(): void {
  if (!nativeSession) return;
  const now = Date.now();
  let list: number[] = [];
  try {
    list = (JSON.parse(nativeSession.getItem(RELOAD_KEY) ?? '[]') as number[]).filter((t) => now - t < 60_000);
  } catch {
    /* leer */
  }
  if (list.length >= 2) return;
  list.push(now);
  safe(() => nativeSession.setItem(RELOAD_KEY, JSON.stringify(list)));
  location.reload();
}

async function unregisterServiceWorkers(): Promise<void> {
  try {
    const regs = await navigator.serviceWorker?.getRegistrations();
    await Promise.all((regs ?? []).map((r) => r.unregister()));
  } catch {
    /* ignorieren */
  }
}

// ---------------------------------------------------------------------------
// Cookies
// ---------------------------------------------------------------------------

const view = new Map<string, StoredCookie>();
/** Lokale Schreibzugriffe, die der Service Worker evtl. noch nicht kennt. */
let pending: { c: StoredCookie; t: number }[] = [];

function replaceCookies(list: StoredCookie[]): void {
  view.clear();
  for (const c of list) view.set(cookieKey(c), c);
  const now = Date.now();
  pending = pending.filter((p) => now - p.t < 3000);
  for (const p of pending) applyCookie(view, p.c, now, { fromScript: true });
}

function installCookies(ctx: Ctx): void {
  const desc = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
  if (!desc?.get || !desc.set) return;
  const nativeGet = desc.get;
  const nativeSet = desc.set;
  const parentDoc = ctx.source === 'parent' ? safe(() => window.parent.document) : null;

  const getCookie = (): string => {
    if (parentDoc) return safe(() => parentDoc.cookie) ?? '';
    const now = Date.now();
    return serializeCookies([...view.values()].filter((c) => !isExpired(c, now) && cookieMatchesUrl(c, location)));
  };
  const setCookie = (v: unknown): void => {
    const str = String(v);
    if (parentDoc) {
      safe(() => (parentDoc.cookie = str));
      return;
    }
    const now = Date.now();
    const c = parseSetCookie(str, new URL(location.href), now, { fromScript: true });
    if (!c) return;
    applyCookie(view, c, now, { fromScript: true });
    pending.push({ c, t: now });
    toBridge({ type: 'setCookie', cookie: str });
  };

  Object.defineProperty(Document.prototype, 'cookie', {
    configurable: true,
    enumerable: true,
    get(this: Document) {
      return this === document ? getCookie() : nativeGet.call(this);
    },
    set(this: Document, v: string) {
      if (this === document) setCookie(v);
      else nativeSet.call(this, v);
    },
  });

  // Asynchrone Cookie Store API abschalten (würde den nativen Speicher nutzen).
  safe(() => delete w.cookieStore);
  if ('cookieStore' in window) {
    safe(() => Object.defineProperty(window, 'cookieStore', { configurable: true, get: () => undefined }));
  }
}

// ---------------------------------------------------------------------------
// localStorage / sessionStorage
// ---------------------------------------------------------------------------

const SP = Storage.prototype;
const nGetItem = SP.getItem;
const nSetItem = SP.setItem;
const nRemoveItem = SP.removeItem;
const nKey = SP.key;
const nLength = Object.getOwnPropertyDescriptor(SP, 'length')!.get!;

function createStorage(native: Storage, prefix: string): Storage {
  const keys = (): string[] => {
    const out: string[] = [];
    const n = nLength.call(native) as number;
    for (let i = 0; i < n; i++) {
      const k = nKey.call(native, i);
      if (k !== null && k.startsWith(prefix)) out.push(k.slice(prefix.length));
    }
    return out;
  };
  const api: Record<string, unknown> = {
    getItem: (k: unknown) => nGetItem.call(native, prefix + String(k)),
    setItem: (k: unknown, v: unknown) => nSetItem.call(native, prefix + String(k), String(v)),
    removeItem: (k: unknown) => nRemoveItem.call(native, prefix + String(k)),
    clear: () => {
      for (const k of keys()) nRemoveItem.call(native, prefix + k);
    },
    key: (i: number) => keys()[Number(i)] ?? null,
  };
  const target = Object.create(Storage.prototype) as Storage;
  const read = (p: string) => nGetItem.call(native, prefix + p);

  return new Proxy(target, {
    get(t, p) {
      if (p === 'length') return keys().length;
      if (typeof p === 'symbol') return p === Symbol.toStringTag ? 'Storage' : Reflect.get(t, p);
      if (Object.prototype.hasOwnProperty.call(api, p)) return api[p];
      if (p in t) return Reflect.get(t, p); // z. B. hasOwnProperty, toString
      return read(p) ?? undefined;
    },
    set(_t, p, v) {
      if (typeof p === 'symbol') return false;
      nSetItem.call(native, prefix + p, String(v));
      return true;
    },
    deleteProperty(_t, p) {
      if (typeof p === 'string') nRemoveItem.call(native, prefix + p);
      return true;
    },
    has(t, p) {
      if (typeof p !== 'string') return p in t;
      return p === 'length' || p in t || read(p) !== null;
    },
    ownKeys() {
      return keys();
    },
    getOwnPropertyDescriptor(_t, p) {
      if (typeof p !== 'string') return undefined;
      const v = read(p);
      return v === null ? undefined : { value: v, writable: true, enumerable: true, configurable: true };
    },
    defineProperty(_t, p, d) {
      if (typeof p !== 'string' || !('value' in d)) return false;
      nSetItem.call(native, prefix + p, String(d.value));
      return true;
    },
  });
}

function installStorage(cid: string): void {
  const prefix = `__tnty:${cid}:`;
  const proxies = new Map<Storage, Storage>();
  for (const [name, native] of [
    ['localStorage', nativeLocal],
    ['sessionStorage', nativeSession],
  ] as const) {
    if (!native) continue;
    const proxy = createStorage(native, prefix);
    proxies.set(native, proxy);
    Object.defineProperty(window, name, { configurable: true, enumerable: true, get: () => proxy });
  }

  // storage-Events: fremde Container ausblenden, Präfix entfernen.
  const synthetic = new WeakSet<Event>();
  window.addEventListener(
    'storage',
    (e) => {
      if (synthetic.has(e)) return;
      e.stopImmediatePropagation();
      if (!e.storageArea || !proxies.has(e.storageArea)) return;
      let key: string | null = e.key;
      if (key !== null) {
        if (!key.startsWith(prefix)) return;
        key = key.slice(prefix.length);
      }
      const ev = new StorageEvent('storage', { key, oldValue: e.oldValue, newValue: e.newValue, url: e.url });
      synthetic.add(ev);
      window.dispatchEvent(ev);
    },
    true,
  );
}

// ---------------------------------------------------------------------------
// IndexedDB, CacheStorage, BroadcastChannel, Web Locks, SharedWorker, SW
// ---------------------------------------------------------------------------

function installNamespaces(cid: string): void {
  const P = `tenantry:${cid}:`;
  const strip = (n: string) => (n.startsWith(P) ? n.slice(P.length) : n);

  // IndexedDB
  if (typeof IDBFactory !== 'undefined') {
    const f = IDBFactory.prototype;
    const open = f.open;
    const del = f.deleteDatabase;
    const dbs = f.databases;
    f.open = function (this: IDBFactory, name: string, version?: number) {
      return version === undefined ? open.call(this, P + name) : open.call(this, P + name, version);
    };
    f.deleteDatabase = function (this: IDBFactory, name: string) {
      return del.call(this, P + name);
    };
    if (dbs) {
      f.databases = async function (this: IDBFactory) {
        const all = await dbs.call(this);
        return all.filter((d) => d.name?.startsWith(P)).map((d) => ({ ...d, name: strip(d.name!) }));
      };
    }
    const nameDesc = Object.getOwnPropertyDescriptor(IDBDatabase.prototype, 'name');
    if (nameDesc?.get) {
      const g = nameDesc.get;
      Object.defineProperty(IDBDatabase.prototype, 'name', {
        ...nameDesc,
        get(this: IDBDatabase) {
          return strip(g.call(this) as string);
        },
      });
    }
  }

  // CacheStorage
  if (typeof CacheStorage !== 'undefined') {
    const c = CacheStorage.prototype;
    const { open, has, delete: del, keys } = c;
    c.open = function (this: CacheStorage, n: string) {
      return open.call(this, P + n);
    };
    c.has = function (this: CacheStorage, n: string) {
      return has.call(this, P + n);
    };
    c.delete = function (this: CacheStorage, n: string) {
      return del.call(this, P + n);
    };
    c.keys = async function (this: CacheStorage) {
      return (await keys.call(this)).filter((k) => k.startsWith(P)).map(strip);
    };
    c.match = async function (this: CacheStorage, req: RequestInfo | URL, opts?: MultiCacheQueryOptions) {
      if (opts?.cacheName) return (await open.call(this, P + opts.cacheName)).match(req, opts);
      for (const k of (await keys.call(this)).filter((k) => k.startsWith(P))) {
        const r = await (await open.call(this, k)).match(req, opts);
        if (r) return r;
      }
      return undefined;
    };
  }

  // BroadcastChannel (MSAL nutzt ihn für tab-übergreifende Synchronisation)
  const NBC = window.BroadcastChannel;
  if (NBC) {
    const nameGet = Object.getOwnPropertyDescriptor(NBC.prototype, 'name')?.get;
    class BroadcastChannel extends NBC {
      constructor(name: string) {
        super(P + String(name));
      }
    }
    if (nameGet) {
      Object.defineProperty(BroadcastChannel.prototype, 'name', {
        configurable: true,
        get(this: BroadcastChannel) {
          return strip(nameGet.call(this) as string);
        },
      });
    }
    Object.defineProperty(window, 'BroadcastChannel', { configurable: true, writable: true, value: BroadcastChannel });
  }

  // Web Locks
  if (typeof LockManager !== 'undefined') {
    const l = LockManager.prototype;
    const req = l.request as (...a: unknown[]) => Promise<unknown>;
    const query = l.query;
    (l as unknown as { request: unknown }).request = function (this: LockManager, name: string, ...rest: unknown[]) {
      return req.call(this, P + name, ...rest);
    };
    l.query = async function (this: LockManager) {
      const s = await query.call(this);
      const own = (list?: LockInfo[]) =>
        (list ?? []).filter((i) => i.name?.startsWith(P)).map((i) => ({ ...i, name: strip(i.name!) }));
      return { held: own(s.held), pending: own(s.pending) };
    };
  }

  // SharedWorker
  const NSW = (window as { SharedWorker?: typeof SharedWorker }).SharedWorker;
  if (NSW) {
    class SharedWorkerT extends NSW {
      constructor(url: string | URL, opts?: string | WorkerOptions) {
        const o: WorkerOptions = typeof opts === 'string' ? { name: opts } : { ...(opts ?? {}) };
        o.name = P + (o.name ?? '');
        super(url, o);
      }
    }
    Object.defineProperty(window, 'SharedWorker', { configurable: true, writable: true, value: SharedWorkerT });
  }

  // Service Worker: Registrierung blockieren, vorhandene Steuerung lösen.
  if (typeof ServiceWorkerContainer !== 'undefined') {
    ServiceWorkerContainer.prototype.register = function () {
      return Promise.reject(new DOMException('Service Worker sind in Tenantry-Containern deaktiviert.', 'SecurityError'));
    };
    if (safe(() => navigator.serviceWorker?.controller)) {
      void unregisterServiceWorkers().then(reloadOnce);
    }
  }
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

function install(ctx: Ctx): void {
  Object.defineProperty(window, CTX_SYMBOL, { value: Object.freeze({ cid: ctx.cid }), configurable: false });
  if (ctx.cookies) replaceCookies(ctx.cookies);
  installCookies(ctx);
  installStorage(ctx.cid);
  installNamespaces(ctx.cid);
  if (ctx.source !== 'parent') setMarker(ctx.cid);
}

function onBridge(ctx: Ctx | null, msg: MainInbound): void {
  if (msg.type === 'cookies') {
    if (ctx && ctx.source !== 'parent' && msg.cid === ctx.cid) replaceCookies(msg.cookies.map(fromTuple));
    return;
  }
  // msg.type === 'ctx': Bestätigung durch den Service Worker
  if (ctx?.source === 'parent') return;
  const assumed = ctx?.cid ?? null;
  if (assumed !== msg.cid) {
    // Tab gehört (inzwischen) zu einem anderen/keinem Container.
    setMarker(msg.cid);
    if (msg.cid) void unregisterServiceWorkers().then(reloadOnce);
    else reloadOnce();
    return;
  }
  if (!ctx) return;
  replaceCookies((msg.cookies as CookieTuple[]).map(fromTuple));
  if (ctx.source === 'marker') {
    // Dokument wurde geladen, bevor die DNR-Regeln aktiv waren (z. B. frisch
    // geöffnetes Popup) -> einmal mit Container-Cookies neu laden.
    reloadOnce();
  }
}

(function main() {
  if (w[INSTALLED]) return;
  Object.defineProperty(window, INSTALLED, { value: true });
  try {
    const ctx = fromParent() ?? fromServerTiming() ?? fromMarker();
    if (ctx) install(ctx);
    window.addEventListener(TO_MAIN, (e) => {
      try {
        onBridge(ctx, JSON.parse(String((e as CustomEvent).detail)) as MainInbound);
      } catch {
        /* ignorieren */
      }
    });
    toBridge({ type: 'sync' });
  } catch (e) {
    console.warn('[Tenantry] Initialisierung fehlgeschlagen', e);
  }
})();
