import { Logger } from '@nestjs/common';
import { SafeFetchTestOptions } from './safe-fetch';

/** Token of the optional `ValidatorsWorkerOptions` provider. Production provides none; tests provide it from a global module. */
export const VALIDATORS_WORKER_OPTIONS = Symbol('VALIDATORS_WORKER_OPTIONS');

/** For tests. Every field has a default that production uses. */
export interface ValidatorsWorkerOptions {
  /** The clock: milliseconds since the Unix epoch. Default `Date.now`. */
  now?: () => number;
  /** Default: a Nest `Logger` with the context of the class that logs. */
  logger?: Pick<Logger, 'log' | 'warn' | 'error'>;
  /** Replaces the outside world for the safe fetcher (the address policy, the DNS, the trusted certificate, the port). */
  fetch?: SafeFetchTestOptions;
  /** Which loops the worker starts, each on by default. A test switches off the ones it does not exercise. */
  start?: { unl?: boolean; domains?: boolean; state?: boolean; compute?: boolean };
}
