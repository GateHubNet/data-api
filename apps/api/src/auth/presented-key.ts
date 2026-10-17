import { Request } from 'express';
import { createHash } from 'node:crypto';

/**
 * The API key a request presents: `X-API-Key: <key>`, else `Authorization: Bearer <key>` (the scheme in any case), the
 * key trimmed. `undefined` when the request carries neither. The one reading of the key, for the authentication
 * (`ApiKeyGuard`) and for the rate limit (`ApiThrottlerGuard`), so both see the same key.
 */
export function presentedApiKey(req: Pick<Request, 'header'>): string | undefined {
  const header = req.header('x-api-key');
  if (header) return header.trim();
  const auth = req.header('authorization');
  if (auth?.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return undefined;
}

/**
 * What the rate limit counts a listed key under: `key:` and the first 16 hex digits of the SHA-256 of the key. The key
 * itself is a secret and stays out of the throttler's storage, of messages, logs and metric labels.
 */
export function rateLimitTracker(key: string): string {
  return `key:${createHash('sha256').update(key).digest('hex').slice(0, 16)}`;
}
