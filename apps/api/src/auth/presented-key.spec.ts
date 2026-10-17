import { Request } from 'express';
import { createHash } from 'node:crypto';
import { presentedApiKey, rateLimitTracker } from './presented-key';

/** A request with the given headers (lower-case names). */
const withHeaders = (headers: Record<string, string>) =>
  ({ header: (name: string) => headers[name.toLowerCase()] }) as Pick<Request, 'header'>;

describe('presentedApiKey', () => {
  it('reads X-API-Key, trimmed', () => {
    expect(presentedApiKey(withHeaders({ 'x-api-key': ' k ' }))).toBe('k');
  });

  it('reads a Bearer token, whatever the case of the scheme, trimmed', () => {
    expect(presentedApiKey(withHeaders({ authorization: 'bearer k' }))).toBe('k');
    expect(presentedApiKey(withHeaders({ authorization: 'Bearer  k ' }))).toBe('k');
  });

  it('prefers X-API-Key when both headers are present', () => {
    expect(presentedApiKey(withHeaders({ 'x-api-key': 'a', authorization: 'Bearer b' }))).toBe('a');
  });

  it('ignores another authorization scheme', () => {
    expect(presentedApiKey(withHeaders({ authorization: 'Basic k' }))).toBeUndefined();
  });

  it('is undefined without a key header', () => {
    expect(presentedApiKey(withHeaders({}))).toBeUndefined();
  });
});

describe('rateLimitTracker', () => {
  it('is "key:" and the first 16 hex digits of the SHA-256 of the key', () => {
    expect(rateLimitTracker('k')).toBe('key:' + createHash('sha256').update('k').digest('hex').slice(0, 16));
  });

  it('does not contain the key', () => {
    expect(rateLimitTracker('explorer-secret')).not.toContain('explorer');
    expect(rateLimitTracker('explorer-secret')).not.toContain('secret');
  });

  it('differs per key and is stable', () => {
    expect(rateLimitTracker('a')).not.toBe(rateLimitTracker('b'));
    expect(rateLimitTracker('a')).toBe(rateLimitTracker('a'));
  });
});
