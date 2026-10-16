import { retryAfterMsOf } from '@gatehub/data-api-shared';

/** Until when a failure that a rate-limited node caused is not logged again (process-wide: one line per pause). */
let throttledUntil = 0;

/**
 * Logs why a request failed (`what`: `GET /v2/... failed`). A failure because the node rate limits this process
 * (`NodeThrottledError`: every endpoint is paused) is logged once per pause, at warn and without a stack: the node client
 * has logged the pause, and every request that needs the node fails the same way until it ends (ruling R98). Anything
 * else is an error with its stack. The response does not depend on it.
 */
export function logFailure(
  logger: { warn(message: string): void; error(message: string, stack?: string): void },
  what: string,
  err: unknown,
): void {
  const message = err instanceof Error ? err.message : String(err);
  const pause = retryAfterMsOf(err);
  if (pause > 0) {
    const now = Date.now();
    if (now < throttledUntil) return;
    throttledUntil = now + pause;
    logger.warn(
      `${what}: ${message} (the failures of the requests that need the node are not logged again until then)`,
    );
    return;
  }
  logger.error(`${what}: ${message}`, err instanceof Error ? err.stack : undefined);
}

/** Forget the pause that was logged (tests). */
export function resetFailureLog(): void {
  throttledUntil = 0;
}
