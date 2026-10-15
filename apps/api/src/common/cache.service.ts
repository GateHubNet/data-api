import { Injectable } from '@nestjs/common';

interface Entry<T> {
  value: T;
  expiresAt: number;
}

/**
 * Minimal in-process TTL cache with a size cap.
 *
 * Used to shield the XRPL node from repeated identical live-state calls
 * (balances / open orders) within a short window. In-process is fine for a single
 * instance; for a horizontally-scaled deployment swap this for a shared Redis cache
 * (the `wrap` signature is the same) so the cache is shared across replicas.
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
    if (this.store.size >= this.maxEntries) {
      // cheap eviction: drop the oldest inserted key
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
    this.store.set(key, { value, expiresAt: now + ttlMs });
    return value;
  }
}
