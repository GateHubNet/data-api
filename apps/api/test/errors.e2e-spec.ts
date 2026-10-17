import { apiKeysOf } from '../src/config/api.config';
import { Harness, startHarness, TEST_API_KEY } from './harness';

const controllers = async () => (await import('./test-controllers')).TEST_CONTROLLERS;

const MISSING_KEY = { result: 'error', message: 'Missing or invalid API key.' };

describe('the Ripple error contract on the toolbox bootstrap', () => {
  describe('with the default settings', () => {
    let h: Harness;
    beforeAll(async () => {
      h = await startHarness({ controllers });
    });
    afterAll(async () => {
      await h?.close();
    });

    describe('authentication', () => {
      it('401 without key -> {result:"error", message:"Missing or invalid API key."}', async () => {
        const res = await h.http().get('/v2/test/ok');
        expect(res.status).toBe(401);
        expect(res.body).toEqual(MISSING_KEY);
      });

      it('401 with a wrong key, and a key in the query string does not count', async () => {
        const wrong = await h.http().get('/v2/test/ok').set('X-API-Key', 'not-the-key');
        expect(wrong.status).toBe(401);
        expect(wrong.body).toEqual(MISSING_KEY);
        const bearer = await h.http().get('/v2/test/ok').set('Authorization', 'Bearer not-the-key');
        expect(bearer.status).toBe(401);
        expect((await h.http().get(`/v2/test/ok?api_key=${h.key}&apikey=${h.key}`)).status).toBe(401);
      });

      it('accepts the key as X-API-Key or as a Bearer token', async () => {
        const header = await h.http().get('/v2/test/ok').set('X-API-Key', h.key);
        expect(header.status).toBe(200);
        expect(header.body).toEqual({ result: 'success' });
        const bearer = await h.http().get('/v2/test/ok').set('Authorization', `Bearer ${h.key}`);
        expect(bearer.status).toBe(200);
      });

      it('the guard exception of a route is rendered by that route controller filter, not by the toolbox one', async () => {
        // The toolbox filter is global in the harness as in production; it would answer {error:{key,message}}.
        const res = await h.http().get('/v2/test/boom');
        expect(res.status).toBe(401);
        expect(res.body).not.toHaveProperty('error');
        expect(res.body).toEqual(MISSING_KEY);
      });

      it('/liveliness/healthz is open without a key', async () => {
        const res = await h.http().get('/liveliness/healthz');
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ status: 'ok' });
      });
    });

    describe('unknown routes', () => {
      it('unknown /v2 route -> 404 Cannot GET /v2/nope', async () => {
        const res = await h.http().get('/v2/nope').set('X-API-Key', h.key);
        expect(res.status).toBe(404);
        expect(res.body).toEqual({ result: 'error', message: 'Cannot GET /v2/nope' });
      });

      it('names the method and the original URL, query string included', async () => {
        const res = await h.http().post('/v2/ledgers/nope/deeper?x=1').set('X-API-Key', h.key);
        expect(res.status).toBe(404);
        expect(res.body).toEqual({ result: 'error', message: 'Cannot POST /v2/ledgers/nope/deeper?x=1' });
      });

      it('/v2 and /v2/ are Ripple 404s too', async () => {
        for (const path of ['/v2', '/v2/']) {
          const res = await h.http().get(path).set('X-API-Key', h.key);
          expect(res.status).toBe(404);
          expect(res.body).toEqual({ result: 'error', message: `Cannot GET ${path}` });
        }
      });

      it('an unknown /v2 route needs the key like any other', async () => {
        const res = await h.http().get('/v2/nope');
        expect(res.status).toBe(401);
        expect(res.body).toEqual(MISSING_KEY);
      });

      it('does not shadow a real route registered by a controller', async () => {
        const res = await h.http().get('/v2/test/ok').set('X-API-Key', h.key);
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ result: 'success' });
      });

      it('a malformed percent-escape in a path parameter is a Ripple 400, not the framework shape (R55)', async () => {
        // Express fails to decode the parameter while it matches the route, before any controller runs
        for (const [path, raw] of [
          ['/v2/accounts/%zz/payments', '%zz'],
          ['/v2/transactions/%E0%A4%A', '%E0%A4%A'],
          ['/V2/ledgers/%/validations', '%'],
        ]) {
          const res = await h.http().get(path).set('X-API-Key', h.key);
          expect([path, res.status, res.body]).toEqual([
            path,
            400,
            { result: 'error', message: `Failed to decode param '${raw}'` },
          ]);
          expect(res.headers['cache-control']).toBe('no-store');
          expect(res.headers['content-type']).toMatch(/^application\/json/);
        }
      });

      it('a well-formed escape in a path parameter is decoded as usual', async () => {
        // %41%42 is AB: an even number of hex digits, so a hash the route looks up (and does not find), not 'invalid hash'
        const found = await h.http().get('/v2/transactions/%41%42').set('X-API-Key', h.key);
        expect([found.status, found.body]).toEqual([404, { result: 'error', message: 'transaction not found' }]);
        // %4 is not an escape: still the decode error, whatever follows
        const bad = await h.http().get('/v2/transactions/%4G').set('X-API-Key', h.key);
        expect([bad.status, bad.body]).toEqual([400, { result: 'error', message: "Failed to decode param '%4G'" }]);
      });

      it('outside /v2 the toolbox global filter still answers (a controller filter beats it only on its own routes)', async () => {
        const res = await h.http().get('/nope').set('X-API-Key', h.key);
        expect(res.status).toBe(404);
        expect(res.body).not.toHaveProperty('result');
        expect(res.body).toMatchObject({
          error: { key: expect.any(String), message: expect.stringContaining('/nope') },
        });
      });
    });

    describe('route failures', () => {
      const get = (path: string) => h.http().get(path).set('X-API-Key', h.key);

      it('a plain Error in a @RippleRoute -> 500 with the route failure message, and the cause is not leaked', async () => {
        const res = await get('/v2/test/boom');
        expect(res.status).toBe(500);
        expect(res.body).toEqual({ result: 'error', message: 'Could not retrieve the test data.' });
        expect(res.text).not.toContain('secret');
      });

      it('an async rejection in a @RippleRoute -> 500 with the route failure message', async () => {
        const res = await get('/v2/test/boom-async');
        expect(res.status).toBe(500);
        expect(res.body).toEqual({ result: 'error', message: 'Could not retrieve the async test data.' });
      });

      it('a plain Error without @RippleRoute -> 500 "internal error"', async () => {
        const res = await get('/v2/test/boom-plain');
        expect(res.status).toBe(500);
        expect(res.body).toEqual({ result: 'error', message: 'internal error' });
        expect(res.text).not.toContain('secret');
      });

      it('a Ripple 4xx keeps its status and message, also through @RippleRoute', async () => {
        const bad = await get('/v2/test/bad-request');
        expect(bad.status).toBe(400);
        expect(bad.body).toEqual({ result: 'error', message: 'invalid test parameter' });
        const missing = await get('/v2/test/missing');
        expect(missing.status).toBe(404);
        expect(missing.body).toEqual({ result: 'error', message: 'test thing not found' });
      });

      it('another HttpException 4xx keeps its status, with its message', async () => {
        const res = await get('/v2/test/forbidden');
        expect(res.status).toBe(403);
        expect(res.body).toEqual({ result: 'error', message: 'not for you' });
      });

      it('another HttpException 5xx becomes a 500 "internal error"', async () => {
        const res = await get('/v2/test/unavailable');
        expect(res.status).toBe(500);
        expect(res.body).toEqual({ result: 'error', message: 'internal error' });
      });

      it('on a @RippleRoute route a 5xx HttpException renders the route failure message too', async () => {
        const res = await get('/v2/test/unavailable-route');
        expect(res.status).toBe(500);
        expect(res.body).toEqual({ result: 'error', message: 'Could not retrieve the test data.' });
        expect(res.text).not.toContain('database is down');
      });
    });

    describe('response headers', () => {
      it('successes carry the Cache-Control of /v2, errors are never cached, other routes are untouched', async () => {
        const ok = await h.http().get('/v2/test/ok').set('X-API-Key', h.key);
        // private: the answers are for the holder of a key, a shared cache must not keep them (R109)
        expect(ok.headers['cache-control']).toBe('private, max-age=60');
        for (const path of ['/v2/test/boom', '/v2/test/bad-request', '/v2/nope']) {
          const res = await h.http().get(path).set('X-API-Key', h.key);
          expect(res.headers['cache-control']).toBe('no-store');
        }
        expect((await h.http().get('/v2/test/ok')).headers['cache-control']).toBe('no-store');
        // The probe is not a /v2 route: terminus answers it with its own header, not the one of the middleware.
        expect((await h.http().get('/liveliness/healthz')).headers['cache-control']).not.toBe('private, max-age=60');
      });

      it('compresses large bodies when the client accepts gzip', async () => {
        const res = await h.http().get('/v2/test/big').set('X-API-Key', h.key).set('Accept-Encoding', 'gzip');
        expect(res.status).toBe(200);
        expect(res.headers['content-encoding']).toBe('gzip');
        expect(res.body.rows).toHaveLength(200);
      });

      it('does not announce the framework and sends no CORS headers by default', async () => {
        const res = await h.http().get('/v2/test/ok').set('X-API-Key', h.key).set('Origin', 'https://app.example.com');
        expect(res.headers['x-powered-by']).toBeUndefined();
        expect(res.headers['access-control-allow-origin']).toBeUndefined();
      });
    });
  });

  describe('with a rate limit of 2 per window (GH_RATE_LIMIT=2)', () => {
    let h: Harness;
    beforeAll(async () => {
      h = await startHarness({ controllers, env: { GH_RATE_LIMIT: '2', GH_RATE_LIMIT_WINDOW: '60' } });
    });
    afterAll(async () => {
      await h?.close();
    });

    it('429 body and Retry-After', async () => {
      const get = () => h.http().get('/v2/test/ok').set('X-API-Key', h.key).set('X-Forwarded-For', '203.0.113.10');
      expect((await get()).status).toBe(200);
      expect((await get()).status).toBe(200);

      const limited = await get();
      expect(limited.status).toBe(429);
      // The original's wording (lib/rateLimit.js): the seconds left in the window, with two decimals.
      expect(limited.body).toEqual({ error: expect.stringMatching(/^Rate limit exceeded, retry in \d+\.\d{2}sec$/) });
      expect(limited.body).not.toHaveProperty('result');
      const seconds = Number(/in (\d+\.\d{2})sec$/.exec(limited.body.error)?.[1]);
      expect(seconds).toBeGreaterThan(0);
      expect(seconds).toBeLessThanOrEqual(60);
      // Retry-After is the same time rounded up to whole seconds, never below 1.
      const retryAfter = Number(limited.headers['retry-after']);
      expect(Number.isInteger(retryAfter)).toBe(true);
      expect(retryAfter).toBeGreaterThanOrEqual(1);
      expect(retryAfter).toBeLessThanOrEqual(60);
      expect(Math.abs(retryAfter - seconds)).toBeLessThan(1.01);
      expect(limited.headers['x-ratelimit-limit']).toBe('2');
      expect(limited.headers['x-ratelimit-remaining']).toBe('0');
      expect(Number(limited.headers['x-ratelimit-reset'])).toBe(retryAfter);
      expect(limited.headers['cache-control']).toBe('no-store');

      // It is the time really left, not a whole number of seconds: it shrinks within the window.
      await new Promise((resolve) => setTimeout(resolve, 120));
      const later = await get();
      expect(later.status).toBe(429);
      const laterSeconds = Number(/in (\d+\.\d{2})sec$/.exec(later.body.error)?.[1]);
      expect(laterSeconds).toBeLessThan(seconds);
    });

    it('counts per client address: X-Forwarded-For is trusted for one hop', async () => {
      const as = (ip: string) => h.http().get('/v2/test/ok').set('X-API-Key', h.key).set('X-Forwarded-For', ip);
      for (let i = 0; i < 2; i++) expect((await as('203.0.113.20')).status).toBe(200);
      expect((await as('203.0.113.20')).status).toBe(429);
      expect((await as('203.0.113.21')).status).toBe(200);
    });

    it('limits a route however its path is spelled (Express routes case-insensitively)', async () => {
      const as = (path: string) => h.http().get(path).set('X-API-Key', h.key).set('X-Forwarded-For', '203.0.113.60');
      expect((await as('/v2/test/ok')).status).toBe(200);
      expect((await as('/V2/Test/OK')).status).toBe(200);
      expect((await as('/v2/TEST/ok')).status).toBe(429);
    });

    it('requests without a valid key do not use up the budget', async () => {
      const as = (key?: string) => {
        const req = h.http().get('/v2/test/ok').set('X-Forwarded-For', '203.0.113.30');
        return key ? req.set('X-API-Key', key) : req;
      };
      for (let i = 0; i < 5; i++) expect((await as()).status).toBe(401);
      expect((await as(h.key)).status).toBe(200);
    });

    it('the guard exception of a route is rendered by that route controller filter, not by the toolbox one', async () => {
      const get = () => h.http().get('/v2/nope').set('X-API-Key', h.key).set('X-Forwarded-For', '203.0.113.40');
      await get();
      await get();
      const limited = await get();
      expect(limited.status).toBe(429);
      expect(limited.body).toEqual({ error: expect.stringMatching(/^Rate limit exceeded/) });
    });

    it('the liveliness probe is not rate limited', async () => {
      for (let i = 0; i < 5; i++) {
        expect((await h.http().get('/liveliness/healthz').set('X-Forwarded-For', '203.0.113.50')).status).toBe(200);
      }
    });
  });

  describe('with per-key limits (GH_RATE_LIMIT_KEYS)', () => {
    // A key's budget is shared by every request that carries it, so each test gets an app (and budget) of its own.
    const LISTED = 'explorer-key';
    const ENV = {
      GH_API_KEYS: `test-key,${LISTED}`,
      GH_RATE_LIMIT_KEYS: `${LISTED}=3`,
      GH_RATE_LIMIT: '2',
      GH_RATE_LIMIT_WINDOW: '60',
    };
    let h: Harness;
    const start = async (env: Record<string, string> = ENV) => {
      h = await startHarness({ controllers, env });
    };
    afterEach(async () => {
      await h?.close();
    });

    /** GET /v2/test/ok with `X-API-Key` from the client address `ip`. */
    const as = (key: string, ip: string) =>
      h.http().get('/v2/test/ok').set('X-API-Key', key).set('X-Forwarded-For', ip);

    it('a listed key shares one budget across client addresses', async () => {
      await start();
      for (const ip of ['203.0.113.30', '203.0.113.31', '203.0.113.32']) {
        expect((await as(LISTED, ip)).status).toBe(200);
      }
      const limited = await as(LISTED, '203.0.113.33');
      expect(limited.status).toBe(429);
      expect(limited.headers['x-ratelimit-limit']).toBe('3');
      expect(limited.body).toEqual({ error: expect.stringMatching(/^Rate limit exceeded, retry in \d+\.\d{2}sec$/) });
    });

    it('X-API-Key and Authorization: Bearer are the same budget', async () => {
      await start();
      const withHeader = () => h.http().get('/v2/test/ok').set('X-API-Key', LISTED);
      const withBearer = () => h.http().get('/v2/test/ok').set('Authorization', `Bearer ${LISTED}`);
      expect((await withHeader()).status).toBe(200);
      expect((await withHeader()).status).toBe(200);
      expect((await withBearer()).status).toBe(200);
      expect((await withBearer()).status).toBe(429);
      expect((await withHeader()).status).toBe(429);
    });

    it('an unlisted key keeps per-address budgets', async () => {
      await start();
      expect((await as(TEST_API_KEY, '203.0.113.40')).status).toBe(200);
      expect((await as(TEST_API_KEY, '203.0.113.40')).status).toBe(200);
      const limited = await as(TEST_API_KEY, '203.0.113.40');
      expect(limited.status).toBe(429);
      expect(limited.headers['x-ratelimit-limit']).toBe('2');
      expect((await as(TEST_API_KEY, '203.0.113.41')).status).toBe(200);
    });

    it('the liveliness probe is not throttled for a listed key', async () => {
      await start();
      for (let i = 0; i < 5; i++) {
        expect((await h.http().get('/liveliness/healthz').set('X-API-Key', LISTED)).status).toBe(200);
      }
    });

    it('a key limit below GH_RATE_LIMIT wins', async () => {
      await start({ ...ENV, GH_RATE_LIMIT_KEYS: `${LISTED}=1`, GH_RATE_LIMIT: '600' });
      expect((await as(LISTED, '203.0.113.50')).status).toBe(200);
      const limited = await as(LISTED, '203.0.113.50');
      expect(limited.status).toBe(429);
      expect(limited.headers['x-ratelimit-limit']).toBe('1');
    });
  });

  describe('with an invalid GH_RATE_LIMIT_KEYS', () => {
    it('the app does not boot when it lists a key that is not in GH_API_KEYS', async () => {
      await expect(
        startHarness({ controllers, env: { GH_API_KEYS: 'test-key,explorer-key', GH_RATE_LIMIT_KEYS: 'zz=3' } }),
      ).rejects.toThrow('GH_RATE_LIMIT_KEYS entry 1 names a key that is not in GH_API_KEYS');
    });
  });

  describe('with CORS origins and a custom Cache-Control', () => {
    let h: Harness;
    beforeAll(async () => {
      h = await startHarness({
        controllers,
        env: {
          GH_CORS_ORIGINS: 'https://app.example.com, https://other.example.com',
          GH_CACHE_CONTROL: 'public, max-age=5',
        },
      });
    });
    afterAll(async () => {
      await h?.close();
    });

    it('allows the configured origins only', async () => {
      const allowed = await h
        .http()
        .get('/v2/test/ok')
        .set('X-API-Key', h.key)
        .set('Origin', 'https://other.example.com');
      expect(allowed.headers['access-control-allow-origin']).toBe('https://other.example.com');
      const denied = await h
        .http()
        .get('/v2/test/ok')
        .set('X-API-Key', h.key)
        .set('Origin', 'https://evil.example.com');
      expect(denied.status).toBe(200);
      expect(denied.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('answers a preflight request without a key', async () => {
      const res = await h
        .http()
        .options('/v2/test/ok')
        .set('Origin', 'https://app.example.com')
        .set('Access-Control-Request-Method', 'GET');
      expect(res.status).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBe('https://app.example.com');
    });

    it('uses GH_CACHE_CONTROL', async () => {
      const res = await h.http().get('/v2/test/ok').set('X-API-Key', h.key);
      expect(res.headers['cache-control']).toBe('public, max-age=5');
    });
  });

  describe('with GH_CORS_ORIGINS=* and an empty GH_CACHE_CONTROL', () => {
    let h: Harness;
    beforeAll(async () => {
      h = await startHarness({ controllers, env: { GH_CORS_ORIGINS: '*', GH_CACHE_CONTROL: '' } });
    });
    afterAll(async () => {
      await h?.close();
    });

    it('allows every origin and sends no Cache-Control', async () => {
      const res = await h
        .http()
        .get('/v2/test/ok')
        .set('X-API-Key', h.key)
        .set('Origin', 'https://anywhere.example.com');
      expect(res.headers['access-control-allow-origin']).toBe('*');
      expect(res.headers['cache-control']).toBeUndefined();
    });
  });

  describe('apiKeysOf', () => {
    it('throws in production when GH_API_KEYS is empty', () => {
      expect(() => apiKeysOf({ apiKeys: '' }, { NODE_ENV: 'production' })).toThrow(
        'GH_API_KEYS must be set in production',
      );
      expect(() => apiKeysOf({ apiKeys: ' , ' }, { NODE_ENV: 'production' })).toThrow(
        'GH_API_KEYS must be set in production',
      );
    });

    it('splits the comma list, and allows an empty one outside production', () => {
      expect(apiKeysOf({ apiKeys: ' a , b,,c ' }, { NODE_ENV: 'production' })).toEqual(['a', 'b', 'c']);
      expect(apiKeysOf({ apiKeys: '' }, { NODE_ENV: 'development' })).toEqual([]);
      expect(apiKeysOf({ apiKeys: '' }, {})).toEqual([]);
    });
  });
});
