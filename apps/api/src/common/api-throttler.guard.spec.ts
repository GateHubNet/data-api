import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ThrottlerModuleOptions, ThrottlerStorage } from '@nestjs/throttler';
import { rateLimitTracker } from '../auth/presented-key';
import { ApiConfig } from '../config/api.config';
import { ApiThrottlerGuard } from './api-throttler.guard';

const OPTIONS: ThrottlerModuleOptions = [{ ttl: 60_000, limit: 2 }];

/** A storage that counts every key by itself and remembers what it was asked. */
function countingStorage() {
  const hits = new Map<string, number>();
  const storage: ThrottlerStorage = {
    increment: async (key) => {
      const totalHits = (hits.get(key) ?? 0) + 1;
      hits.set(key, totalHits);
      return { totalHits, timeToExpire: 60 };
    },
  };
  return { storage, hits };
}

function guardWith(config: Partial<ApiConfig>, storage: ThrottlerStorage = countingStorage().storage) {
  return new ApiThrottlerGuard(OPTIONS, storage, new Reflector(), config as ApiConfig);
}

const CONFIG = { apiKeys: 'test-key,explorer-key', rateLimitKeys: 'explorer-key=3' };

/** A request with the given headers (lower-case names) and client address. */
const request = (headers: Record<string, string> = {}, ip = '203.0.113.1') => ({
  ip,
  path: '/v2/test/ok',
  header: (name: string) => headers[name.toLowerCase()],
});

describe('ApiThrottlerGuard', () => {
  describe('construction', () => {
    it('fails on a rate limit entry whose key is not an API key', () => {
      expect(() => guardWith({ apiKeys: 'test-key,explorer-key', rateLimitKeys: 'zz=3' })).toThrow(
        'GH_RATE_LIMIT_KEYS entry 1 names a key that is not in GH_API_KEYS',
      );
    });

    it('is built without per-key limits', () => {
      expect(() => guardWith({ apiKeys: 'test-key', rateLimitKeys: '' })).not.toThrow();
    });
  });

  describe('getTracker', () => {
    // `getTracker` is protected: this is the function the throttler itself calls.
    const trackerOf = (guard: ApiThrottlerGuard, req: ReturnType<typeof request>) =>
      (guard as unknown as { getTracker(req: unknown): Promise<string> }).getTracker(req);

    it('is a digest of the key for a listed key, in X-API-Key or as a Bearer token', async () => {
      const guard = guardWith(CONFIG);
      expect(await trackerOf(guard, request({ 'x-api-key': 'explorer-key' }))).toBe(rateLimitTracker('explorer-key'));
      expect(await trackerOf(guard, request({ authorization: 'Bearer explorer-key' }))).toBe(
        rateLimitTracker('explorer-key'),
      );
      expect(await trackerOf(guard, request({ 'x-api-key': ' explorer-key ' }))).toBe(rateLimitTracker('explorer-key'));
    });

    it('does not depend on the client address for a listed key', async () => {
      const guard = guardWith(CONFIG);
      const a = await trackerOf(guard, request({ 'x-api-key': 'explorer-key' }, '203.0.113.1'));
      const b = await trackerOf(guard, request({ 'x-api-key': 'explorer-key' }, '203.0.113.2'));
      expect(a).toBe(b);
    });

    it('is the client address for a key that is not listed, a missing key and a foreign scheme', async () => {
      const guard = guardWith(CONFIG);
      expect(await trackerOf(guard, request({ 'x-api-key': 'test-key' }, '203.0.113.7'))).toBe('203.0.113.7');
      expect(await trackerOf(guard, request({}, '203.0.113.8'))).toBe('203.0.113.8');
      expect(await trackerOf(guard, request({ authorization: 'Basic explorer-key' }, '203.0.113.9'))).toBe(
        '203.0.113.9',
      );
    });
  });

  describe('counting through the throttler', () => {
    const context = (req: ReturnType<typeof request>) => {
      const headers: Record<string, unknown> = {};
      const res = { header: (name: string, value: unknown) => (headers[name] = value), setHeader: jest.fn() };
      const ctx = {
        switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
        getHandler: () => function handler() {},
        getClass: () => class Controller {},
      } as unknown as ExecutionContext;
      return { ctx, headers };
    };

    async function started(config: Partial<ApiConfig>) {
      const { storage, hits } = countingStorage();
      const guard = guardWith(config, storage);
      await guard.onModuleInit();
      return { guard, hits };
    }

    it('counts a listed key under its digest, with its own limit, and never stores the key', async () => {
      const { guard, hits } = await started(CONFIG);
      for (const ip of ['203.0.113.1', '203.0.113.2', '203.0.113.3']) {
        const { ctx, headers } = context(request({ 'x-api-key': 'explorer-key' }, ip));
        expect(await guard.canActivate(ctx)).toBe(true);
        expect(headers['X-RateLimit-Limit']).toBe(3);
      }
      expect(hits.size).toBe(1);
      expect([...hits.values()]).toEqual([3]);
      expect(JSON.stringify([...hits.keys()])).not.toContain('explorer');
    });

    it('counts a key that is not listed per client address with the default limit', async () => {
      const { guard, hits } = await started(CONFIG);
      const { ctx, headers } = context(request({ 'x-api-key': 'test-key' }, '203.0.113.40'));
      expect(await guard.canActivate(ctx)).toBe(true);
      expect(headers['X-RateLimit-Limit']).toBe(2);
      await guard.canActivate(context(request({ 'x-api-key': 'test-key' }, '203.0.113.41')).ctx);
      expect(hits.size).toBe(2);
    });

    it('does not count the liveliness probe', async () => {
      const { guard, hits } = await started(CONFIG);
      const req = { ...request({ 'x-api-key': 'explorer-key' }), path: '/liveliness/healthz' };
      expect(await guard.canActivate(context(req).ctx)).toBe(true);
      expect(hits.size).toBe(0);
    });
  });
});
