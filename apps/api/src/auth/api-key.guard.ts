import { CanActivate, ExecutionContext, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { UNAUTHORIZED_MESSAGE } from '../common/ripple-error.filter';
import { ApiConfig, apiKeysOf } from '../config/api.config';

const digest = (key: string): Buffer => createHash('sha256').update(key).digest();

/**
 * API-key authentication.
 *
 * Clients send their key in a header: either `X-API-Key: <key>` or the standard `Authorization: Bearer <key>`. (Header,
 * not query string: query params leak into access logs, browser history and referrers.) Keys are compared in constant
 * time.
 *
 * If no keys are configured (`GH_API_KEYS` empty) the guard lets everything through so local development works out
 * of the box; `apiKeysOf` refuses an empty list in production, so a deployed API is never open by accident.
 *
 * The liveliness probe (`/liveliness/*`) needs no key. The Prometheus scrape endpoint is a separate app on its own
 * port, and the swagger docs are served by the toolbox outside the Nest routes, so neither reaches this guard.
 * The guard throws the 401; `RippleErrorFilter` of the route's controller renders it.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly openPaths = [/^\/liveliness\//];
  /** SHA-256 of each key: equal-length buffers, so the comparison takes the same time whatever the lengths. */
  private readonly digests: Buffer[];

  constructor(config: ApiConfig) {
    const keys = apiKeysOf(config);
    this.digests = keys.map(digest);
    if (keys.length === 0) {
      new Logger(ApiKeyGuard.name).warn('GH_API_KEYS is empty: the API is UNAUTHENTICATED (development only).');
    }
  }

  canActivate(context: ExecutionContext): boolean {
    if (this.digests.length === 0) return true; // authentication disabled

    const req = context.switchToHttp().getRequest<Request>();
    if (this.openPaths.some((re) => re.test(req.path))) return true;

    const presented = this.extractKey(req);
    if (!presented || !this.isValid(presented)) {
      throw new UnauthorizedException(UNAUTHORIZED_MESSAGE);
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
    const candidate = digest(presented);
    let matched = false;
    for (const key of this.digests) {
      if (timingSafeEqual(key, candidate)) matched = true;
    }
    return matched;
  }
}
