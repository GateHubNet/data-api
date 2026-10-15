import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Request, Response } from 'express';
import { RateLimitError, rateLimitMessage, RippleHttpError } from './errors';

/** What every Ripple route says when it fails for a reason the caller did not cause and the route has no message for. */
export const INTERNAL_ERROR_MESSAGE = 'internal error';

/** The message `ApiKeyGuard` rejects with; the filter says it for every 401. */
export const UNAUTHORIZED_MESSAGE = 'Missing or invalid API key.';

/** The text of an HttpException: a string response, the `message` of an object response (an array is joined). */
function messageOf(exception: HttpException): string {
  const response = exception.getResponse();
  if (typeof response === 'string') return response;
  const message = (response as { message?: unknown }).message;
  if (Array.isArray(message)) return message.join(', ');
  return typeof message === 'string' ? message : exception.message;
}

/**
 * Renders every error of a Ripple route as the data API v2 does: `{"result":"error","message":"..."}`.
 *
 * - A `RippleHttpError` keeps its status and message, whatever the status (`@RippleRoute` raises the 500 ones).
 * - Any other HttpException below 500 keeps its status and message; a 401 (the API key guard) always says
 *   `Missing or invalid API key.`.
 * - A 429 (the throttler) is `{"error":"Rate limit exceeded, retry in <n.nn>sec"}`, the original's wording: `n.nn` is the
 *   time left in the window, to two decimals (`RateLimitError`; a bare 429 falls back to its `Retry-After`).
 * - Anything else (an Error, an HttpException of 500 and above) is a 500 `internal error`; the cause is logged, never
 *   sent. A route that wants its own message uses `@RippleRoute`.
 *
 * It is applied per controller by `@RippleController`: the toolbox `bootstrap()` installs its own global filter
 * (`{"error":{"key","message"}}`), and a controller-level filter takes precedence over a global one. Guard
 * exceptions are raised inside the route's pipeline, so the filter of the route's controller renders them too.
 */
@Catch()
export class RippleErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger('RippleError');

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const res = http.getResponse<Response>();
    if (res.headersSent) {
      // Too late for a Ripple body: the response has begun. End it, so that the client does not wait for the rest.
      this.logger.error(
        `${http.getRequest<Request>().originalUrl} failed after the response had started: ${exception instanceof Error ? exception.message : String(exception)}`,
        exception instanceof Error ? exception.stack : undefined,
      );
      res.end();
      return;
    }
    // An error is never cacheable; the Cache-Control of /v2 is set before the route runs.
    res.setHeader('Cache-Control', 'no-store');

    if (exception instanceof RippleHttpError) {
      // 4xx of the route's own checks, or the 500 `@RippleRoute` has already logged the cause of.
      res.status(exception.getStatus()).json({ result: 'error', message: messageOf(exception) });
      return;
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      if (status === HttpStatus.TOO_MANY_REQUESTS) {
        // The throttler's own 429 carries no fraction: fall back to its whole-second Retry-After.
        const seconds =
          exception instanceof RateLimitError ? exception.retryAfterSeconds : Number(res.getHeader('Retry-After')) || 1;
        res.status(status).json({ error: rateLimitMessage(seconds) });
        return;
      }
      if (status === HttpStatus.UNAUTHORIZED) {
        res.status(status).json({ result: 'error', message: UNAUTHORIZED_MESSAGE });
        return;
      }
      if (status >= 400 && status < 500) {
        res.status(status).json({ result: 'error', message: messageOf(exception) });
        return;
      }
    }

    const req = http.getRequest<Request>();
    this.logger.error(
      `${req.method} ${req.originalUrl} failed: ${exception instanceof Error ? exception.message : String(exception)}`,
      exception instanceof Error ? exception.stack : undefined,
    );
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ result: 'error', message: INTERNAL_ERROR_MESSAGE });
  }
}
