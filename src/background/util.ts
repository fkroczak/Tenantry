/** Führt Aufgaben strikt nacheinander aus (keine Überschneidung von async-Abläufen). */
export function serialQueue() {
  let chain: Promise<unknown> = Promise.resolve();
  return function run<T>(task: () => Promise<T>): Promise<T> {
    const next = chain.then(task, task);
    chain = next.catch(() => undefined);
    return next;
  };
}

export function log(...args: unknown[]): void {
  console.debug('[Tenantry]', ...args);
}

export function warn(...args: unknown[]): void {
  console.warn('[Tenantry]', ...args);
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function randomId(prefix: string): string {
  const b = crypto.getRandomValues(new Uint8Array(5));
  return prefix + [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/** chrome.tabs.* schlägt während eines Tab-Drags fehl – kurz warten und erneut versuchen. */
export async function retry<T>(fn: () => Promise<T>, attempts = 4, delay = 150): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      await sleep(delay * (i + 1));
    }
  }
  throw last;
}
