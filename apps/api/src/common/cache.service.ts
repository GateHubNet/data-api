import { Injectable } from '@nestjs/common';

interface Entry<T> {
  value: T;
  expiresAt: number;
}

/**
 * Minimal in-process TTL cache with a size cap.
 *
 * Used to shield the XRPL node from repeated identical live-state calls
 * (balances / open orders) within a short window, and ClickHouse from recomputing the rates of days that have no
 * `native_rates_daily` set yet (`DailyRates`). In-process is fine for a single
 * instance; for a horizontally-scaled deployment swap this for a shared Redis cache
 * (the `wrap`, `get` and `set` signatures are the same) so the cache is shared across replicas.
 */
@Injectable()
export class CacheService {
  private readonly store = new Map<string, Entry<unknown>>();
  private readonly maxEntries = 10_000;

  async wrap<T>(key: string, ttlMs: number, producer: () => Promise<T>): Promise<T> {
    if (ttlMs <= 0) return producer();

    const now = Date.now();
    const hit = this.store.get(key);
    if (hit && hit.expiresAt > now) return hit.value as T;

    const value = await producer();
    this.put(key, value, now + ttlMs);
    return value;
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

  /** Drops everything. Only the e2e suites call it, so that one test does not see what another cached. */
  clear(): void {
    this.store.clear();
  }

  private put<T>(key: string, value: T, expiresAt: number): void {
    if (this.store.size >= this.maxEntries) {
      // cheap eviction: drop the oldest inserted key
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
    this.store.set(key, { value, expiresAt });
  }
}
