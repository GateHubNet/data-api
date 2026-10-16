import { EventEmitter } from 'events';

/** A pause the node asked for is never longer than this (20 minutes): a hint is advice, not a contract. */
export const MAX_THROTTLE_PAUSE_MS = 20 * 60_000;
/** The pause after a rate-limit answer that names no wait (`slowDown`, `tooBusy`, an HTTP 429). */
export const DEFAULT_THROTTLE_PAUSE_MS = 10_000;
/** Added to the node's hint: its `~` is an estimate, and a request a moment too early starts the next pause. */
const HINT_MARGIN_MS = 250;

/** rippled's own codes for "you are sending too much" (`rpcSLOW_DOWN`, `rpcTOO_BUSY`). */
const THROTTLE_CODES = new Set(['slowDown', 'tooBusy']);
/**
 * The texts of a rate-limit answer: the public proxies (`rate limit: units quota (50000 per 10s) exhausted, retry in
 * ~12376ms`), rippled (`You are placing too much load on the server.`, `The server is too busy to help you now.`) and a
 * websocket handshake refused with HTTP 429.
 */
const THROTTLE_TEXT = /rate limit|slowDown|tooBusy|too busy|too much load|server response: 429|too many requests/i;
const HINT_TEXT = /retry in ~?\s*(\d+)\s*ms/i;

/** Everything an error says about itself: its message and the rippled `error` / `error_message` it carries. */
function errorText(err: unknown): string {
  const parts: string[] = [];
  if (err instanceof Error) parts.push(err.message);
  else if (typeof err === 'string') parts.push(err);
  const data = (err as { data?: { error?: unknown; error_message?: unknown } } | null | undefined)?.data;
  if (typeof data === 'object' && data !== null) {
    for (const value of [data.error, data.error_message]) if (typeof value === 'string') parts.push(value);
  }
  return parts.join(' ');
}

/**
 * Whether `err` is a node's rate-limit answer (a request or a connection refused because this client sends too much),
 * and the wait it asks for: `{ retryInMs }` for a `retry in ~<N>ms` hint, `{}` for a rate-limit answer without one, and
 * undefined for any other error.
 */
export function throttleHint(err: unknown): { retryInMs?: number } | undefined {
  const code = (err as { data?: { error?: unknown } } | null | undefined)?.data?.error;
  const text = errorText(err);
  const hint = HINT_TEXT.exec(text);
  if (hint) return { retryInMs: Number(hint[1]) };
  if ((typeof code === 'string' && THROTTLE_CODES.has(code)) || THROTTLE_TEXT.test(text)) return {};
  return undefined;
}

/** `wss://user:key@host:443/path` -> `host:443`: endpoints may carry credentials, so logs and metrics only get this. */
export function endpointHostOf(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return '(invalid url)';
  }
}

/**
 * A request that was not sent, or a rate-limit answer: every endpoint it could go to is paused because the node asked
 * this client to slow down. `retryAfterMs` is the wait until the first of them may be used again.
 */
export class NodeThrottledError extends Error {
  constructor(
    readonly endpoints: string[],
    readonly retryAfterMs: number,
    readonly reason: string,
  ) {
    super(
      `Rate limited by ${endpoints.map(endpointHostOf).join(', ')}: nothing is sent to it for ` +
        `${(retryAfterMs / 1000).toFixed(1)} s (${reason})`,
    );
    this.name = 'NodeThrottledError';
  }
}

/** The wait a `NodeThrottledError` asks for (by name too, so that it holds across copies of this package), else 0. */
export function retryAfterMsOf(err: unknown): number {
  if (err instanceof NodeThrottledError) return err.retryAfterMs;
  const candidate = err as { name?: unknown; retryAfterMs?: unknown } | null | undefined;
  return candidate?.name === 'NodeThrottledError' && typeof candidate.retryAfterMs === 'number'
    ? candidate.retryAfterMs
    : 0;
}

export interface EndpointThrottleOptions {
  /** Cap of a pause. Default `MAX_THROTTLE_PAUSE_MS` (20 min). */
  maxPauseMs?: number;
  /** A pause without a hint. Default `DEFAULT_THROTTLE_PAUSE_MS` (10 s). */
  defaultPauseMs?: number;
  /** The clock (tests). */
  now?: () => number;
}

/** What `pause` emits (`'pause'` event), once per pause that starts. */
export interface ThrottlePause {
  endpoint: string;
  /** `endpointHostOf(endpoint)`: no credentials. */
  host: string;
  /** Length of the pause. */
  ms: number;
  /** The node's answer. */
  reason: string;
}

/**
 * The endpoints that told this process to slow down, and until when (ruling R98). Every `NodeClient` of the process
 * shares one (`nodeThrottle`), so a pause holds for all of them: the shared client, the per-node clients of the
 * validations collector, and a client the API makes again after a failed start. While an endpoint is paused nothing is
 * sent to it and no connection to it is attempted.
 *
 * Emits `'pause'` (`ThrottlePause`) when a pause starts (not when a running one is extended): the apps count it in
 * Prometheus.
 */
export class EndpointThrottle extends EventEmitter {
  private readonly until = new Map<string, number>();
  private readonly maxPauseMs: number;
  private readonly defaultPauseMs: number;
  private readonly now: () => number;

  constructor(opts: EndpointThrottleOptions = {}) {
    super();
    this.maxPauseMs = opts.maxPauseMs ?? MAX_THROTTLE_PAUSE_MS;
    this.defaultPauseMs = opts.defaultPauseMs ?? DEFAULT_THROTTLE_PAUSE_MS;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Pause `endpoint` for what the rate-limit answer `err` asks (its hint plus a margin, or the default; at most
   * `maxPauseMs`). A running pause is only ever extended. Returns the remaining pause and whether this call started it.
   */
  pause(endpoint: string, err: unknown): { ms: number; started: boolean } {
    const hint = throttleHint(err) ?? {};
    const wanted = hint.retryInMs === undefined ? this.defaultPauseMs : hint.retryInMs + HINT_MARGIN_MS;
    const ms = Math.max(0, Math.min(wanted, this.maxPauseMs));
    const now = this.now();
    const started = this.remainingMs(endpoint) === 0;
    this.until.set(endpoint, Math.max(this.until.get(endpoint) ?? 0, now + ms));
    const remaining = this.remainingMs(endpoint);
    if (started) {
      const event: ThrottlePause = { endpoint, host: endpointHostOf(endpoint), ms: remaining, reason: errorText(err) };
      try {
        this.emit('pause', event);
      } catch {
        // a listener (a metrics counter) must not break the request path
      }
    }
    return { ms: remaining, started };
  }

  /** How long `endpoint` stays paused; 0 when it may be used. */
  remainingMs(endpoint: string): number {
    const until = this.until.get(endpoint);
    if (until === undefined) return 0;
    const left = until - this.now();
    if (left > 0) return left;
    this.until.delete(endpoint);
    return 0;
  }

  /** 0 when one of `endpoints` may be used now, else the wait until the first of them may. */
  waitMs(endpoints: readonly string[]): number {
    let wait = Number.POSITIVE_INFINITY;
    for (const endpoint of endpoints) wait = Math.min(wait, this.remainingMs(endpoint));
    return endpoints.length === 0 ? 0 : wait;
  }

  /** Forget every pause (tests). */
  clear(): void {
    this.until.clear();
  }
}

/** The throttle every `NodeClient` of the process uses unless it is given another one (tests). */
export const nodeThrottle = new EndpointThrottle();
