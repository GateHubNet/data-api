import { ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { ThrottlerLimitDetail } from '@nestjs/throttler/dist/throttler.guard.interface';
import { Request, Response } from 'express';

/**
 * The rate limit of the API: the Nest throttler, counted per client address and route (the client address is
 * `req.ip`, which honours `X-Forwarded-For` for `GH_TRUST_PROXY_HOPS` hops).
 *
 * - Everything is limited except the liveliness probe. (Not "only /v2": Express routes case-insensitively, so
 *   `/V2/...` is the same endpoint, and a check on the spelling of the path would let it past the limit.)
 * - A rejected request carries `Retry-After` (set by the throttler) and the `X-RateLimit-*` headers; the throttler sets
 *   those only on the requests it lets through. `RippleErrorFilter` renders the 429 body.
 */
@Injectable()
export class ApiThrottlerGuard extends ThrottlerGuard {
  protected async shouldSkip(context: ExecutionContext): Promise<boolean> {
    const { path } = context.switchToHttp().getRequest<Request>();
    return /^\/liveliness(\/|$)/i.test(path);
  }

  protected async throwThrottlingException(context: ExecutionContext, detail: ThrottlerLimitDetail): Promise<void> {
    const res = context.switchToHttp().getResponse<Response>();
    res.setHeader('X-RateLimit-Limit', detail.limit);
    res.setHeader('X-RateLimit-Remaining', 0);
    res.setHeader('X-RateLimit-Reset', detail.timeToExpire);
    await super.throwThrottlingException(context, detail);
  }
}
