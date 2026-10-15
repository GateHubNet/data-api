export const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Run an async fn with bounded retries and exponential backoff. */
export async function retry<T>(
  fn: () => Promise<T>,
  opts: { attempts?: number; baseDelayMs?: number; maxDelayMs?: number; onRetry?: (err: unknown, attempt: number) => void } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 5;
  const baseDelayMs = opts.baseDelayMs ?? 250;
  const maxDelayMs = opts.maxDelayMs ?? 10_000;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === attempts) break;
      opts.onRetry?.(err, attempt);
      const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      await wait(delay);
    }
  }
  throw lastErr;
}

/** Split an array into fixed-size chunks. */
export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/**
 * Wait for every promise to settle, then reject with the first failure (in list order) if there was one.
 *
 * Unlike `Promise.all` this never rejects while a sibling is still pending, so no call of the failed attempt is still
 * running on the client. It says nothing about the server: a request the client abandoned (a timeout, a dropped
 * connection) may still be executing there.
 */
export async function allSettledOrThrow(promises: Promise<unknown>[]): Promise<void> {
  const results = await Promise.allSettled(promises);
  const failure = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failure) throw failure.reason;
}
