import { ClickHouseService, Table } from '@gatehub/data-api-shared';
import { Injectable } from '@nestjs/common';
import { decodeMarker, keysetClause, KeysetKey, paginate } from '../common/pagination';
import { StoredValidation, toValidation, Validation } from './validation-object';

/** The key of a validation within a ledger, and so its marker: the validator's key (the ORDER BY after `ledger_hash`). */
export const VALIDATION_KEYS: KeysetKey[] = [{ column: 'validation_public_key', type: 'String' }];

/**
 * One validation = all the partial rows of a (ledger_hash, validation_public_key), added up: `sum(count)`, the earliest
 * `first_datetime`, the latest `last_datetime`. `validations` is an AggregatingMergeTree, so until a merge (and, with
 * sightings that fall into different day partitions, ever) a validation is several rows; the read never counts on a merge.
 *
 * The other columns are `SimpleAggregateFunction(any)`, which keeps an arbitrary value on a merge. Here they are the
 * value of the EARLIEST sighting (`argMin` by `first_datetime`): the same value on every read, whichever parts are read
 * in whichever order, so that a page walk and a repeated request agree. (A merged row has one value; it is that one.)
 *
 * Datetimes leave as unix milliseconds (`Int64`), which the object formats; the 64-bit fee columns leave as text, which
 * keeps every digit.
 */
const VALIDATION_COLUMNS = `
  ledger_hash,
  validation_public_key,
  sum(count) AS count,
  toUnixTimestamp64Milli(min(first_datetime)) AS first_ms,
  toUnixTimestamp64Milli(max(last_datetime)) AS last_ms,
  argMin(ledger_index, first_datetime) AS ledger_index,
  argMin(reporter_public_key, first_datetime) AS reporter_public_key,
  argMin(ephemeral_public_key, first_datetime) AS ephemeral_public_key,
  argMin(signature, first_datetime) AS signature,
  argMin(signing_time, first_datetime) AS signing_time,
  argMin(flags, first_datetime) AS flags,
  argMin(full, first_datetime) AS full,
  argMin(amendments, first_datetime) AS amendments,
  toString(argMin(base_fee, first_datetime)) AS base_fee,
  toString(argMin(load_fee, first_datetime)) AS load_fee,
  toString(argMin(reserve_base, first_datetime)) AS reserve_base,
  toString(argMin(reserve_inc, first_datetime)) AS reserve_inc`;

/**
 * The validations of a ledger (`getLedgerValidations` and the single-row scan of `getLedgerValidations.js`).
 *
 * The ledger hash is the first column of the ORDER BY of `validations`, so the read is a primary key range; the marker
 * (the last validator's key of the page before) is the next column of the key. No FINAL: the GROUP BY on the whole key
 * does what a merge would. The original matched a hash, and a validator key, by PREFIX (a scan from `<hash>` to
 * `<hash>~`); here both are matched exactly.
 */
@Injectable()
export class ValidationsService {
  constructor(private readonly ch: ClickHouseService) {}

  /** A page of the validations of `ledgerHash`, ordered by validator key, `limit` at most. */
  async list(ledgerHash: string, limit: number, marker?: string): Promise<{ rows: Validation[]; marker?: string }> {
    const after = decodeMarker(marker, VALIDATION_KEYS);
    const cursor = keysetClause(VALIDATION_KEYS, false, after);
    const rows = await this.ch.query<StoredValidation>(
      `SELECT ${VALIDATION_COLUMNS}
         FROM ${Table.Validations}
        WHERE ledger_hash = {hash:String}${cursor.clause === '' ? '' : ` AND ${cursor.clause}`}
        GROUP BY ledger_hash, validation_public_key
        ORDER BY validation_public_key ASC
        LIMIT {fetch:UInt32}`,
      // one row more than the page: it only tells whether there is a next page
      { hash: ledgerHash, ...cursor.params, fetch: limit + 1 },
    );
    const page = paginate(rows, limit, (row) => [row.validation_public_key]);
    return { rows: page.rows.map(toValidation), ...(page.marker !== undefined && { marker: page.marker }) };
  }

  /** One validation of a ledger, or `undefined`. */
  async get(ledgerHash: string, validationPublicKey: string): Promise<Validation | undefined> {
    const row = await this.ch.queryOne<StoredValidation>(
      `SELECT ${VALIDATION_COLUMNS}
         FROM ${Table.Validations}
        WHERE ledger_hash = {hash:String} AND validation_public_key = {pubkey:String}
        GROUP BY ledger_hash, validation_public_key
        LIMIT 1`,
      { hash: ledgerHash, pubkey: validationPublicKey },
    );
    return row && toValidation(row);
  }
}
