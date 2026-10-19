import { RIPPLE_EPOCH_MS } from '@gatehub/data-api-shared';
import { fmtMillis, fmtTime } from '../common/format';

/*
 * The objects `GET /v2/network/validators/{key}/validations` answers (spec 3.4). Pure: keys in the order of the constants
 * below, a key with no value absent, never `null`. Instants of receipt are `YYYY-MM-DDTHH:mm:ss.SSSZ`, the validator's own
 * signing time `YYYY-MM-DDTHH:mm:ssZ`.
 */

/** The keys of the answer, in order. `marker` is there when more follow. */
export const VALIDATIONS_BODY_KEYS = ['result', 'validation_public_key', 'count', 'marker', 'validations'] as const;

/** The keys of a validation, in order. `validated_hash` is there only when `validated` is `different`. */
export const VALIDATION_ROW_KEYS = [
  'ledger_index',
  'ledger_hash',
  'validated',
  'validated_hash',
  'full',
  'signing_key',
  'signing_time',
  'first_datetime',
  'last_datetime',
  'count',
] as const;

/** The seconds from the Unix epoch to the Ripple epoch: the validator signs its time in seconds since 2000-01-01. */
const RIPPLE_EPOCH_SECONDS = RIPPLE_EPOCH_MS / 1000;

/**
 * A validation of the page as the read of `validator_validations` gives it: the sightings of one (ledger index, ledger hash)
 * added up, whatever key they were recorded under. ClickHouse sends 64-bit integers as text, so numbers are read through
 * `Number()` either way. The names are not the columns': an alias with the name of the column it aggregates would be
 * read as the column.
 */
export interface StoredValidation {
  ledger_index: number | string;
  ledger_hash: string;
  /** The sum of the `count` of the sightings. */
  sightings: number | string;
  /** The earliest `first_datetime`, in unix milliseconds. */
  first_ms: number | string;
  /** The latest `last_datetime`, in unix milliseconds. */
  last_ms: number | string;
  /** The `ephemeral_public_key` of the earliest sighting. */
  signing_key: string;
  /** The `signing_time` of the earliest sighting: seconds since the Ripple epoch. */
  signed_at: number | string;
  /** The greatest `full` of the sightings: 1 for a full validation, 0 for a partial one. */
  is_full: number | string;
}

/** Whether the ledger of that index, as the indexer holds it, is the one the validator validated. */
export type Validated = 'matches' | 'different' | 'unknown';

export interface ValidationRow {
  ledger_index: number;
  ledger_hash: string;
  validated: Validated;
  /** The hash of the ledger at that index, only when it is not the one validated. */
  validated_hash?: string;
  full: boolean;
  signing_key: string;
  signing_time: string;
  first_datetime: string;
  last_datetime: string;
  count: number;
}

export interface ValidationsBody {
  result: 'success';
  validation_public_key: string;
  count: number;
  marker?: string;
  validations: ValidationRow[];
}

/**
 * The validation of a stored row. `ledgerHash` is the hash of the ledger the indexer holds at that index, or `undefined`
 * without one (not indexed yet, or outside the indexed history). Hashes are hex, compared without regard to case.
 */
export function validationRow(stored: StoredValidation, ledgerHash: string | undefined): ValidationRow {
  const validated: Validated =
    ledgerHash === undefined
      ? 'unknown'
      : ledgerHash.toUpperCase() === stored.ledger_hash.toUpperCase()
        ? 'matches'
        : 'different';
  return {
    ledger_index: Number(stored.ledger_index),
    ledger_hash: stored.ledger_hash,
    validated,
    ...(validated === 'different' && { validated_hash: ledgerHash }),
    full: Number(stored.is_full) === 1,
    signing_key: stored.signing_key,
    signing_time: fmtTime(Number(stored.signed_at) + RIPPLE_EPOCH_SECONDS),
    first_datetime: fmtMillis(new Date(Number(stored.first_ms))),
    last_datetime: fmtMillis(new Date(Number(stored.last_ms))),
    count: Number(stored.sightings),
  };
}

/** The answer for a master key: `result`, the key, the number of validations of the page, the marker when there is one, the page. */
export function buildValidationsBody(master: string, rows: ValidationRow[], marker?: string): ValidationsBody {
  return {
    result: 'success',
    validation_public_key: master,
    count: rows.length,
    ...(marker !== undefined && { marker }),
    validations: rows,
  };
}
