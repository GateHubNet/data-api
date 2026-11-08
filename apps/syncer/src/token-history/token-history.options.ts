import { Logger } from '@nestjs/common';

/** The options of the `token_history` worker that the tests set (the defaults are the spec's). */
export interface TokenHistoryWorkerOptions {
  /** `false`: the loop is not started at boot (the tests run passes themselves). */
  start?: boolean;
  logger?: Pick<Logger, 'log' | 'warn' | 'error' | 'debug'>;
  /** The lease holder's name (default: host, pid and a nonce). */
  holder?: string;
  pollMs?: number;
  /** The checkpoint floor and the window of `touchesOfWindow` (the tests lower them; default the spec's). */
  floor?: number;
  window?: number;
  /** What a pass may spend on the steps after the live windows (default `TOKEN_HISTORY_PASS_BUDGET_MS`). */
  budgetMs?: number;
  now?: () => number;
}

export const TOKEN_HISTORY_WORKER_OPTIONS = Symbol('TOKEN_HISTORY_WORKER_OPTIONS');
