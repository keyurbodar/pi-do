export class AsyncKeyMutex {
  private tails = new Map<string, Promise<void>>();
  async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const cur = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = prev.then(() => cur);
    this.tails.set(key, tail);
    try {
      await prev.catch(() => {});
      return await fn();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

export function evictOldest<K, V>(entries: Map<K, V>, age: (value: V) => number | null, full: string): void {
  let oldest: K | undefined;
  let oldestAge = Infinity;
  for (const [key, value] of entries) {
    const at = age(value);
    if (at === null || at >= oldestAge) continue;
    oldest = key;
    oldestAge = at;
  }
  if (oldest === undefined) throw new Error(full);
  entries.delete(oldest);
}

export function mapBounded<K, V>(entries: Map<K, V>, key: K, make: () => V, age: (value: V) => number | null, limit: number, full: string): V {
  if (!entries.has(key) && entries.size >= limit) evictOldest(entries, age, full);
  const value = make();
  entries.set(key, value);
  return value;
}

export interface TimeoutScope {
  controller: AbortController;
  signal: AbortSignal;
  timedOut: () => boolean;
  dispose: () => void;
}

export function withTimeoutSignal(ms: number): TimeoutScope {
  const controller = new AbortController();
  let hit = false;
  const timer = setTimeout(() => {
    hit = true;
    controller.abort(new Error("Execution timed out"));
  }, ms);
  return { controller, signal: controller.signal, timedOut: () => hit, dispose: () => clearTimeout(timer) };
}

export function execAborted(scope: TimeoutScope, killRequested: boolean): boolean {
  return scope.timedOut() || killRequested || scope.signal.aborted;
}

export interface ExecEnd {
  stdout: string;
  stderr: string;
  exit: number;
  timedOut: boolean;
  killed: boolean;
}

export function execEnd(killed: boolean): ExecEnd {
  return { stdout: "", stderr: "", exit: 124, timedOut: true, killed };
}
