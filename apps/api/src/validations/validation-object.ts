import { badRequest } from '../common/errors';
import { compact, fmtMillis } from '../common/format';

/**
 * What the aggregate read of `validations` returns for one (ledger_hash, validation_public_key): the partial rows added
 * up (see `ValidationsService`). ClickHouse sends `UInt64` and `Int64` as JSON text or numbers depending on its settings,
 * so the integers are read through `Number()`/`String()` either way.
 */
export interface StoredValidation {
  count: number | string;
  first_ms: number | string;
  last_ms: number | string;
  amendments: string;
  base_fee: string | null;
  ephemeral_public_key: string;
  flags: number | string;
  full: number;
  ledger_hash: string;
  ledger_index: number | string;
  load_fee: string | null;
  reporter_public_key: string;
  reserve_base: string | null;
  reserve_inc: string | null;
  signature: string;
  signing_time: number | string;
  validation_public_key: string;
}

/**
 * A validation as `GET /v2/ledgers/:hash/validations` served it (R73). The original answered with the row the Thrift
 * client read from HBase (`validations_by_ledger`): every column as TEXT in the order the server returns them, family by
 * family and name by name (`rowkey` removed), where the route made `count` a number and nothing else. So: the keys are
 * sorted by name, the values are text (`flags: "2147483649"`, `ledger_index: "46087342"`, `full: "true"`), and a column
 * that was empty is not there at all (the writer did not store an empty value: no `amendments`, no fee fields when the
 * validation carried none, no `full` on a partial validation). Datetimes are `YYYY-MM-DDTHH:mm:ss.SSSZ`.
 *
 * `ephemeral_public_key` is the signing key the validation was made with. The original wrote it for the rows of its first
 * collector (they are in its mock data) and not any more; here it is stored again, so it is served when there is one.
 */
export interface Validation {
  amendments?: string;
  base_fee?: string;
  count: number;
  ephemeral_public_key?: string;
  first_datetime: string;
  flags: string;
  full?: 'true';
  last_datetime: string;
  ledger_hash: string;
  ledger_index: string;
  load_fee?: string;
  reporter_public_key?: string;
  reserve_base?: string;
  reserve_inc?: string;
  signature: string;
  signing_time: string;
  validation_public_key: string;
}

const orNothing = (value: string | null): string | undefined => (value === null || value === '' ? undefined : value);

/** The served form of a stored validation: R73, in the order of the keys of the original's row. */
export function toValidation(row: StoredValidation): Validation {
  return compact<Validation>({
    amendments: orNothing(row.amendments),
    base_fee: orNothing(row.base_fee),
    count: Number(row.count),
    ephemeral_public_key: orNothing(row.ephemeral_public_key),
    first_datetime: fmtMillis(new Date(Number(row.first_ms))),
    flags: String(row.flags),
    full: Number(row.full) === 1 ? 'true' : undefined,
    last_datetime: fmtMillis(new Date(Number(row.last_ms))),
    ledger_hash: row.ledger_hash,
    ledger_index: String(row.ledger_index),
    load_fee: orNothing(row.load_fee),
    reporter_public_key: orNothing(row.reporter_public_key),
    reserve_base: orNothing(row.reserve_base),
    reserve_inc: orNothing(row.reserve_inc),
    signature: row.signature,
    signing_time: String(row.signing_time),
    validation_public_key: row.validation_public_key,
  });
}

// the original's test (`getLedgerValidations.js`): hex, with an optional lower-case `0x`, of an even length
const HEX = /^(0x)?[0-9A-Fa-f]+$/;

/**
 * The ledger hash of the path: hex of even length (counting a `0x` prefix, which is two characters), else 400
 * `invalid ledger hash`. Upper-cased, which is how hashes are stored. Bug fix: the original upper-cased `0x...` to `0X...`,
 * which no stored hash starts with; the prefix is dropped here, so `0x<hash>` finds the ledger.
 */
export function parseLedgerHash(raw: string): string {
  if (!HEX.test(raw) || raw.length % 2 !== 0) throw badRequest('invalid ledger hash');
  return raw.replace(/^0x/, '').toUpperCase();
}
