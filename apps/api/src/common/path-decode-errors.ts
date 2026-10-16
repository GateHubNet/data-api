import type { NextFunction, Request, Response } from 'express';

/** A path that belongs to the Ripple API: `/v2` and below, matched case-insensitively as Express matches routes. */
const V2_PATH = /^\/v2(\/|$)/i;

/** The first `/`-separated segment of a path that `decodeURIComponent` refuses. */
function undecodableSegment(path: string): string | undefined {
  return path.split('/').find((segment) => {
    try {
      decodeURIComponent(segment);
      return false;
    } catch {
      return true;
    }
  });
}

/**
 * Express error middleware for a malformed percent-escape in the path of a `/v2` request (`/v2/accounts/%zz/payments`;
 * Ruling R55). Express fails to decode the parameter while it matches the routes (a `URIError` with status 400), before
 * any controller runs, so no Ripple filter sees it, and Nest's own exception handler would answer in the framework's
 * shape. It answers the Ripple shape instead: `400 {"result":"error","message":"Failed to decode param '%zz'"}`, the
 * text Express gives such an error, naming the segment that could not be decoded (the message the original's Express
 * produced for its route parameter). Errors are never cached (`no-store`), as everywhere in `/v2`.
 *
 * It has to sit after the routes and before Nest's exception handler: `AppModule.onModuleInit` adds it, which Nest calls
 * between the two. Any other error, and any other path, passes on.
 */
export function pathDecodeErrors(err: unknown, req: Request, res: Response, next: NextFunction): void {
  if (!(err instanceof URIError) || (err as { status?: unknown }).status !== 400 || !V2_PATH.test(req.path)) {
    next(err);
    return;
  }
  res.status(400);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ result: 'error', message: `Failed to decode param '${undecodableSegment(req.path) ?? req.path}'` });
}
