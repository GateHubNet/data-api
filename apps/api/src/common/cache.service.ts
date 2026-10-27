import { Injectable } from '@nestjs/common';

interface Entry<T> {
  value: T;
  expiresAt: number;
}

/**
 * Minimal in-process TTL cache with a size cap.
 *
 * Used to shield the XRPL node from repeated identical live-state calls
 * (balances / open orders) within a short window, and, as an instance of its own (`RATES_CACHE`), ClickHouse from
 * recomputing the rates of days that have no `native_rates_daily` set yet (`DailyRates`). In-process is fine for a single
 * instance; for a horizontally-scaled deployment swap this for a shared Redis cache
 * (the `wrap`, `get` and `set` signatures are the same) so the cache is shared across replicas.
 */
@Injectable()
export class CacheService {
  private readonly store = new Map<string, Entry<unknown>>();
  /** The producers of `wrap` that are running, by key: the misses that come while one runs wait for it. */
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly maxEntries = 10_000;

  /**
   * The value kept under `key`, or else what `producer` gives, kept for `ttlMs` (counted from the call). Misses of one key that
   * come while its producer runs share that run: the producer is called once, and they all get its value, or its rejection. A
   * rejection is never kept: the next call after it runs the producer again. A ttl of 0 or less keeps nothing and shares nothing.
   */
  async wrap<T>(key: string, ttlMs: number, producer: () => Promise<T>): Promise<T> {
    if (ttlMs <= 0) return producer();

    const now = Date.now();
    const hit = this.store.get(key);
    if (hit && hit.expiresAt > now) return hit.value as T;
    const running = this.inFlight.get(key);
    if (running) return running as Promise<T>;

    const produced = (async () => producer())();
    this.inFlight.set(key, produced);
    try {
      const value = await produced;
      // a `clear` while it ran drops it: the value is of the time before
      if (this.inFlight.get(key) === produced) this.put(key, value, now + ttlMs);
      return value;
    } finally {
      if (this.inFlight.get(key) === produced) this.inFlight.delete(key);
    }
  }

  /** The value kept under `key`, `undefined` when there is none or its ttl is over. */
  get<T>(key: string): T | undefined {
    const hit = this.store.get(key);
    return hit && hit.expiresAt > Date.now() ? (hit.value as T) : undefined;
  }

  /** Keeps `value` under `key` for `ttlMs` milliseconds, as `wrap` does; a ttl of 0 or less keeps nothing. */
  set<T>(key: string, value: T, ttlMs: number): void {
    if (ttlMs <= 0) return;
    this.put(key, value, Date.now() + ttlMs);
  }

  /**
   * Drops everything, and forgets the producers that are running (their values are not kept, and a new call runs its own). Only
   * the e2e suites call it, so that one test does not see what another cached.
   */
  clear(): void {
    this.store.clear();
    this.inFlight.clear();
  }

  private put<T>(key: string, value: T, expiresAt: number): void {
    // a key that is kept already is taken out first: refreshing it evicts no other key, and puts it at the newest position
    this.store.delete(key);
    if (this.store.size >= this.maxEntries) {
      // cheap eviction: drop the oldest inserted key
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
    this.store.set(key, { value, expiresAt });
  }
}
