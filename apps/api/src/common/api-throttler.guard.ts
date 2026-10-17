import { ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  InjectThrottlerOptions,
  InjectThrottlerStorage,
  ThrottlerGenerateKeyFunction,
  ThrottlerGetTrackerFunction,
  ThrottlerGuard,
  ThrottlerModuleOptions,
  ThrottlerOptions,
  ThrottlerStorage,
  ThrottlerStorageService,
} from '@nestjs/throttler';
import type { ThrottlerLimitDetail } from '@nestjs/throttler/dist/throttler.guard.interface';
import { Request, Response } from 'express';
import { presentedApiKey, rateLimitTracker } from '../auth/presented-key';
import { ApiConfig, rateLimitKeysOf } from '../config/api.config';
import { RateLimitError } from './errors';

/**
 * The rate limit of the API: the Nest throttler, counted per client address and route (the client address is
 * `req.ip`, which honours `X-Forwarded-For` for `GH_TRUST_PROXY_HOPS` hops), or per key and route for an API key listed
 * in `GH_RATE_LIMIT_KEYS`: that key's requests are one count whatever their address, against the limit listed for the
 * key in place of `GH_RATE_LIMIT`. The count is per replica, as it is for an address.
 *
 * - Everything is limited except the liveliness probe. (Not "only /v2": Express routes case-insensitively, so
 *   `/V2/...` is the same endpoint, and a check on the spelling of the path would let it past the limit.)
 * - A rejected request is a `RateLimitError` (429, rendered by `RippleErrorFilter` in the original's wording) with
 *   `Retry-After` in whole seconds and the `X-RateLimit-*` headers; the throttler sets those headers only on the
 *   requests it lets through.
 */
@Injectable()
export class ApiThrottlerGuard extends ThrottlerGuard {
  /** The requests per window of each key of `GH_RATE_LIMIT_KEYS`. */
  private readonly keyLimits: Map<string, number>;

  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storage: ThrottlerStorage,
    reflector: Reflector,
    config: ApiConfig,
  ) {
    super(options, storage, reflector);
    this.keyLimits = rateLimitKeysOf(config); // throws now, as `apiKeysOf` does in `ApiKeyGuard`, on an invalid setting
  }

  /**
   * A listed key is counted under a digest of the key (never the key, which would end up in the storage), whatever the
   * address; everything else under the client address. The throttler calls this method through `commonOptions`, which
   * `onModuleInit` binds to it.
   */
  protected async getTracker(req: Record<string, unknown>): Promise<string> {
    const key = presentedApiKey(req as unknown as Pick<Request, 'header'>);
    return key !== undefined && this.keyLimits.has(key) ? rateLimitTracker(key) : (req.ip as string);
  }

  protected async handleRequest(
    context: ExecutionContext,
    limit: number,
    ttl: number,
    throttler: ThrottlerOptions,
    getTracker: ThrottlerGetTrackerFunction,
    generateKey: ThrottlerGenerateKeyFunction,
  ): Promise<boolean> {
    // Replaces the limit of every throttler: a route-level @Throttle or a second named throttler (none exist today)
    // would need this revisited.
    const key = presentedApiKey(context.switchToHttp().getRequest<Request>());
    const keyLimit = key === undefined ? undefined : this.keyLimits.get(key);
    return super.handleRequest(context, keyLimit ?? limit, ttl, throttler, getTracker, generateKey);
  }

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
