import { HttpException } from '@nestjs/common';

/**
 * An error with a Ripple message. `RippleErrorFilter` renders it as `{"result":"error","message":"<message>"}` with
 * its status: 4xx for the caller's mistakes, 500 for a failure the route reports with its own message.
 */
export class RippleHttpError extends HttpException {
  constructor(status: number, message: string) {
    super({ result: 'error', message }, status);
  }
}

/** 400 with the exact message of the Ripple route (`invalid ledger identifier`, ...). */
export const badRequest = (message: string): RippleHttpError => new RippleHttpError(400, message);

/** 404 with the exact message of the Ripple route (`ledger not found`, ...). */
export const notFound = (message: string): RippleHttpError => new RippleHttpError(404, message);

/** The body of a rejected request, as the original rate limiter words it: two decimals of seconds. */
export const rateLimitMessage = (seconds: number): string => `Rate limit exceeded, retry in ${seconds.toFixed(2)}sec`;

/**
 * The 429 of the rate limit. `retryAfterSeconds` is the time left in the window, with its fraction: the original
 * (`lib/rateLimit.js`) answers `retry in <reset - now, toFixed(2)>sec` and a whole-second `Retry-After`.
 */
export class RateLimitError extends HttpException {
  constructor(readonly retryAfterSeconds: number) {
    super(rateLimitMessage(retryAfterSeconds), 429);
  }
}
