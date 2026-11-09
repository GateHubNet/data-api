import {
  ClickHouseService,
  applyLiveWindow,
  catchUpLevels,
  dexHoursFromPairHourly,
  dexThrough,
  dropRetired,
  oldestFinalPairHour,
  promoteIfCaughtUp,
  readTokenHistoryStates,
  rebuildNeeded,
  repairOldestRange,
} from '@gatehub/data-api-shared';
import { Logger } from '@nestjs/common';

/** The shared functions the worker's steps call; the unit tests replace them. */
export const TOKEN_HISTORY_STEPS = {
  readStates: readTokenHistoryStates,
  applyLiveWindow,
  catchUpLevels,
  repairOldestRange,
  promoteIfCaughtUp,
  dropRetired,
  rebuildNeeded,
  dexThrough,
  oldestFinalPairHour,
  dexHoursFromPairHourly,
};

export type TokenHistorySteps = typeof TOKEN_HISTORY_STEPS;

/** The options of the `token_history` worker that the tests set (the defaults are the spec's). */
export interface TokenHistoryWorkerOptions {
  /** `false`: the loop is not started at boot (the tests run passes themselves). */
  start?: boolean;
  /**
   * The client of the catch-up and the repair, whose statements can take minutes: the syncer's client with the build's lifted guards
   * (`ClickHouseService.derive`) unless given (the tests).
   */
  heavyClient?: ClickHouseService;
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
  /** The shared functions of the steps (the unit tests' fakes). */
  steps?: Partial<TokenHistorySteps>;
}

export const TOKEN_HISTORY_WORKER_OPTIONS = Symbol('TOKEN_HISTORY_WORKER_OPTIONS');
