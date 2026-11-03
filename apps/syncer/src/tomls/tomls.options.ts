import { Logger } from '@nestjs/common';
import { SafeFetchTestOptions } from '../validators/safe-fetch';

/** Token of the optional `TomlsWorkerOptions` provider. Production provides none; tests provide it from a global module. */
export const TOMLS_WORKER_OPTIONS = Symbol('TOMLS_WORKER_OPTIONS');

/**
 * Token of the `SafeFetcher` of `TomlsModule`: its own, with the user agent of the tomls worker (`tomlsUserAgent()`), apart
 * from the one of the validators worker.
 */
export const TOMLS_SAFE_FETCHER = Symbol('TOMLS_SAFE_FETCHER');

/** For tests. Every field has a default that production uses. */
export interface TomlsWorkerOptions {
  /** The clock of the discovery, the checks and the loops: milliseconds since the Unix epoch. Default `Date.now`. */
  now?: () => number;
  /** Default: a Nest `Logger` with the context of the class that logs. */
  logger?: Pick<Logger, 'log' | 'warn' | 'error'>;
  /** Replaces the outside world for the safe fetcher (the address policy, the DNS, the trusted certificate, the port). */
  fetch?: SafeFetchTestOptions;
  /** Which loops the worker starts, each on by default. A test switches off the ones it does not exercise. */
  start?: { discovery?: boolean; checks?: boolean };
}
