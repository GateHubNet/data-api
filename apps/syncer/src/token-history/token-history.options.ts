import { Logger } from '@nestjs/common';

/** The options of the `token_history` worker that the tests set (the defaults are the spec's). */
export interface TokenHistoryWorkerOptions {
  /** `false`: the loop is not started at boot (the tests run passes themselves). */
  start?: boolean;
  logger?: Pick<Logger, 'log' | 'warn' | 'error' | 'debug'>;
  /** The lease holder's name (default: host, pid and a nonce). */
  holder?: string;
  pollMs?: number;
}

export const TOKEN_HISTORY_WORKER_OPTIONS = Symbol('TOKEN_HISTORY_WORKER_OPTIONS');
