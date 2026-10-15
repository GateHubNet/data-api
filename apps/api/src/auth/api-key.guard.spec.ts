import { ExecutionContext, Logger, UnauthorizedException } from '@nestjs/common';
import { ApiConfig } from '../config/api.config';
import { ApiKeyGuard } from './api-key.guard';

/** An ExecutionContext for a request with the given path and headers (lower-case names). */
function contextFor(path: string, headers: Record<string, string> = {}): ExecutionContext {
  const req = { path, header: (name: string) => headers[name.toLowerCase()] };
  return { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
}

const guardWith = (apiKeys: string) => new ApiKeyGuard({ apiKeys } as ApiConfig);

describe('ApiKeyGuard', () => {
  const guard = guardWith('alpha, beta');
  afterEach(() => jest.restoreAllMocks());

  it('accepts any configured key in X-API-Key', () => {
    expect(guard.canActivate(contextFor('/v2/ledgers', { 'x-api-key': 'alpha' }))).toBe(true);
    expect(guard.canActivate(contextFor('/v2/ledgers', { 'x-api-key': ' beta ' }))).toBe(true);
  });

  it('accepts a key as a Bearer token, whatever the case of the scheme', () => {
    expect(guard.canActivate(contextFor('/v2/ledgers', { authorization: 'Bearer beta' }))).toBe(true);
    expect(guard.canActivate(contextFor('/v2/ledgers', { authorization: 'bearer alpha' }))).toBe(true);
  });

  it.each([
    ['no key', {}],
    ['a wrong key', { 'x-api-key': 'gamma' }],
    ['a key that is only a prefix', { 'x-api-key': 'alph' }],
    ['a key with a suffix', { 'x-api-key': 'alphaa' }],
    ['a wrong bearer token', { authorization: 'Bearer gamma' }],
    ['another auth scheme', { authorization: 'Basic alpha' }],
  ])('rejects %s with the Ripple message', (_name, headers) => {
    expect(() => guard.canActivate(contextFor('/v2/ledgers', headers))).toThrow(UnauthorizedException);
    expect(() => guard.canActivate(contextFor('/v2/ledgers', headers))).toThrow('Missing or invalid API key.');
  });

  it('needs no key on the liveliness probe', () => {
    expect(guard.canActivate(contextFor('/liveliness/healthz'))).toBe(true);
  });

  it('does not open paths that merely look like the probe', () => {
    expect(() => guard.canActivate(contextFor('/liveliness'))).toThrow(UnauthorizedException);
    expect(() => guard.canActivate(contextFor('/v2/liveliness/healthz'))).toThrow(UnauthorizedException);
  });

  it('lets every request through when no keys are configured (development), and says so', () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    expect(guardWith('').canActivate(contextFor('/v2/ledgers'))).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('UNAUTHENTICATED'));
  });

  it('refuses to be built in production without keys', () => {
    const saved = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() => guardWith('')).toThrow('GH_API_KEYS must be set in production');
    } finally {
      process.env.NODE_ENV = saved;
    }
  });
});
