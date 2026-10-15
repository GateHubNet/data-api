/** What the liveliness probe needs to know about the ingest worker. */
export interface IngestStatus {
  /** How many ledgers the committed checkpoint is behind the validated head; undefined until it is known. */
  lag?: number;
  /** `'halted'` fails the probe at once (a chain break); other states are informational. */
  state?: string;
}

export interface IngestStatusProvider {
  status(): IngestStatus;
}

/**
 * Provided by the ingest worker's module (`{ provide: INGEST_STATUS, useExisting: LiveRunner }`), which must be
 * `@Global()` and export the token so that the liveliness module can see it. When no module provides it (the ingest
 * worker is not enabled) the probe only checks ClickHouse.
 */
export const INGEST_STATUS = Symbol('INGEST_STATUS');
