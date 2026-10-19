import { Logger } from '@nestjs/common';
import { SafeFetchTestOptions } from './safe-fetch';

/** Token of the optional `ValidatorsWorkerOptions` provider. Production provides none; tests provide it from a global module. */
export const VALIDATORS_WORKER_OPTIONS = Symbol('VALIDATORS_WORKER_OPTIONS');

/**
 * Token of the `AmendmentsConfig` provider of `ValidatorsModule`: the amendment metadata of the network, loaded from
 * `GH_AMENDMENTS_CONFIG` (the file shipped with the shared package when it is empty) at boot, so that an invalid file fails
 * the boot. It is here, and not in `validators.module.ts`, for the classes that inject it (the module imports them).
 */
export const AMENDMENTS_CONFIG = Symbol('AMENDMENTS_CONFIG');

/** For tests. Every field has a default that production uses. */
export interface ValidatorsWorkerOptions {
  /** The clock of the loops and the jobs: milliseconds since the Unix epoch. Default `Date.now`. */
  now?: () => number;
  /** Default: a Nest `Logger` with the context of the class that logs. */
  logger?: Pick<Logger, 'log' | 'warn' | 'error'>;
  /** Replaces the outside world for the safe fetcher (the address policy, the DNS, the trusted certificate, the port). */
  fetch?: SafeFetchTestOptions;
  /** The timeout of each request to the node for the network state and the features, in ms. Default 5000. */
  nodeRequestTimeoutMs?: number;
  /**
   * Which loops the worker starts, each on by default. A test switches off the ones it does not exercise. `compute` is the
   * compute loop, with the seeding of `validator_seen` that runs in the background beside it.
   */
  start?: { unl?: boolean; domains?: boolean; state?: boolean; compute?: boolean };
}
