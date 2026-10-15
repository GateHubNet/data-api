import { ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard, ThrottlerStorageService } from '@nestjs/throttler';
import type { ThrottlerLimitDetail } from '@nestjs/throttler/dist/throttler.guard.interface';
import { Request, Response } from 'express';
import { RateLimitError } from './errors';

/**
 * The rate limit of the API: the Nest throttler, counted per client address and route (the client address is
 * `req.ip`, which honours `X-Forwarded-For` for `GH_TRUST_PROXY_HOPS` hops).
 *
 * - Everything is limited except the liveliness probe. (Not "only /v2": Express routes case-insensitively, so
 *   `/V2/...` is the same endpoint, and a check on the spelling of the path would let it past the limit.)
 * - A rejected request is a `RateLimitError` (429, rendered by `RippleErrorFilter` in the original's wording) with
 *   `Retry-After` in whole seconds and the `X-RateLimit-*` headers; the throttler sets those headers only on the
 *   requests it lets through.
 */
@Injectable()
export class ApiThrottlerGuard extends ThrottlerGuard {
  protected async shouldSkip(context: ExecutionContext): Promise<boolean> {
    const { path } = context.switchToHttp().getRequest<Request>();
    return /^\/liveliness(\/|$)/i.test(path);
  }

  protected async throwThrottlingException(context: ExecutionContext, detail: ThrottlerLimitDetail): Promise<void> {
    const seconds = this.secondsUntilReset(detail);
    const res = context.switchToHttp().getResponse<Response>();
    res.setHeader('Retry-After', Math.max(1, Math.ceil(seconds)));
    res.setHeader('X-RateLimit-Limit', detail.limit);
    res.setHeader('X-RateLimit-Remaining', 0);
    res.setHeader('X-RateLimit-Reset', Math.max(1, Math.ceil(seconds)));
    throw new RateLimitError(seconds);
  }

  /**
   * The time left in the window, with its fraction (the original's `reset - now`). The throttler reports whole seconds
   * only; its in-memory storage, the default, also keeps the exact expiry.
   */
  private secondsUntilReset(detail: ThrottlerLimitDetail): number {
    const record =
      this.storageService instanceof ThrottlerStorageService ? this.storageService.storage[detail.key] : undefined;
    return record ? Math.max(0, (record.expiresAt - Date.now()) / 1000) : detail.timeToExpire;
  }
}
