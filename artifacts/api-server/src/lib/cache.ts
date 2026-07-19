/**
 * TtlCache<T> — in-process TTL cache with singleflight deduplication.
 *
 * Singleflight means: if 500 concurrent requests arrive for the same key,
 * only ONE upstream fetch fires. All 500 await the same Promise.
 * After resolution the value is stored and served from cache for `ttlMs`.
 *
 * This is the primary mechanism keeping upstream sites from rate-limiting
 * the server under high concurrency (1M+ users/day).
 */
export class TtlCache<T> {
  private data    = new Map<string, { val: T; exp: number }>();
  private inflight = new Map<string, Promise<T>>();
  private pruneTimer: ReturnType<typeof setInterval>;

  constructor(pruneIntervalMs = 60_000) {
    // Background sweep so stale entries don't accumulate forever
    this.pruneTimer = setInterval(() => this.prune(), pruneIntervalMs);
    if (this.pruneTimer.unref) this.pruneTimer.unref(); // don't block Node exit
  }

  get(key: string): T | undefined {
    const entry = this.data.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.exp) { this.data.delete(key); return undefined; }
    return entry.val;
  }

  set(key: string, val: T, ttlMs: number): void {
    this.data.set(key, { val, exp: Date.now() + ttlMs });
  }

  /**
   * dedupe(key, fn, ttlMs)
   *
   * 1. Cache hit?  → return immediately.
   * 2. Already in-flight for this key? → join that Promise (singleflight).
   * 3. Neither? → call fn(), store result, resolve all waiters.
   */
  async dedupe(key: string, fn: () => Promise<T>, ttlMs: number): Promise<T> {
    const cached = this.get(key);
    if (cached !== undefined) return cached;

    const existing = this.inflight.get(key);
    if (existing) return existing;

    const promise = fn()
      .then((val) => {
        this.set(key, val, ttlMs);
        this.inflight.delete(key);
        return val;
      })
      .catch((err) => {
        this.inflight.delete(key);
        throw err;
      });

    this.inflight.set(key, promise);
    return promise;
  }

  size(): number { return this.data.size; }

  private prune(): void {
    const now = Date.now();
    for (const [k, v] of this.data) {
      if (now > v.exp) this.data.delete(k);
    }
  }
}

/** Shared fetch with AbortController timeout — prevents hung upstream connections. */
export async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs = 10_000,
): Promise<Response> {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}
