import { CanActivate, ExecutionContext, Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { Request } from 'express';
import { API_CONFIG, ApiConfig } from '../config/api.config';

/**
 * API-key authentication.
 *
 * Clients send their key in a header — either `X-API-Key: <key>` or the standard
 * `Authorization: Bearer <key>`. (Header, not query string: query params leak into
 * access logs, browser history and referrers.) Keys are compared in constant time.
 *
 * If no keys are configured (`GH_API_KEYS` empty) the guard is a no-op so local/dev
 * works out of the box; in production an empty key set logs a loud warning (see config).
 *
 * Operational paths (`/liveliness/*`, `/metricz`, `/internal/docs*`) are always allowed
 * so probes and scrapers don't need a key.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly logger = new Logger(ApiKeyGuard.name);
  private readonly openPaths = [/^\/liveliness\//, /^\/metricz/, /^\/internal\/docs/];

  constructor(@Inject(API_CONFIG) private readonly config: ApiConfig) {}

  canActivate(context: ExecutionContext): boolean {
    if (this.config.apiKeys.length === 0) return true; // auth disabled

    const req = context.switchToHttp().getRequest<Request>();
    if (this.openPaths.some((re) => re.test(req.path))) return true;

    const presented = this.extractKey(req);
    if (!presented || !this.isValid(presented)) {
      throw new UnauthorizedException('Missing or invalid API key.');
    }
    return true;
  }

  private extractKey(req: Request): string | undefined {
    const header = req.header('x-api-key');
    if (header) return header.trim();
    const auth = req.header('authorization');
    if (auth?.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
    return undefined;
  }

  /** Constant-time comparison against every configured key. */
  private isValid(presented: string): boolean {
    const presentedBuf = Buffer.from(presented);
    let matched = false;
    for (const key of this.config.apiKeys) {
      const keyBuf = Buffer.from(key);
      // timingSafeEqual requires equal lengths; compare against a same-length buffer.
      const a = keyBuf.length === presentedBuf.length ? presentedBuf : Buffer.alloc(keyBuf.length);
      if (timingSafeEqual(keyBuf, a) && keyBuf.length === presentedBuf.length) matched = true;
    }
    return matched;
  }
}
