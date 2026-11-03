import { ClickHouseService, Table } from '@gatehub/data-api-shared';
import { Injectable } from '@nestjs/common';
import { FeatureCoverageService } from '../common/feature-coverage.service';
import { StoredMptIssuance } from './mpt-objects';

/**
 * The columns of an issuance as `StoredMptIssuance` holds them: each `UInt64` as its digits (a number would lose those above 2^53)
 * and the creation time as unix seconds. The aliases are not the names of columns, which the `ORDER BY` of the read would then mean.
 */
const ISSUANCE_COLUMNS = `mpt_issuance_id, issuer, sequence, state_known, flags, asset_scale,
       toString(maximum_amount) AS maximum_text, toString(outstanding_amount) AS outstanding_text,
       toString(escrowed_amount) AS escrowed_text, toString(locked_amount) AS locked_text,
       locked_holders, holders, transfer_fee, metadata_hex, metadata, metadata_conforms, ticker, name,
       created_ledger, toUnixTimestamp(created_time) AS created_unix, created_tx_hash, last_ledger, destroyed`;

/** A row as `ISSUANCE_COLUMNS` reads it. */
type IssuanceRead = Omit<
  StoredMptIssuance,
  'maximum_amount' | 'outstanding_amount' | 'escrowed_amount' | 'locked_amount' | 'created_time'
> & {
  maximum_text: string | null;
  outstanding_text: string;
  escrowed_text: string;
  locked_text: string;
  created_unix: number | null;
};

function storedOf(row: IssuanceRead): StoredMptIssuance {
  const { maximum_text, outstanding_text, escrowed_text, locked_text, created_unix, ...rest } = row;
  return {
    ...rest,
    maximum_amount: maximum_text,
    outstanding_amount: outstanding_text,
    escrowed_amount: escrowed_text,
    locked_amount: locked_text,
    created_time: created_unix,
  };
}

/**
 * The issuances (spec 7.2 and 7.5): the newest version of each row of `mpt_issuances`, read by the primary key and never with
 * `FINAL`. A network without MPT reads nothing and has none (ruling C19): every route of an issuance answers as for one with no row.
 */
@Injectable()
export class MptService {
  constructor(
    private readonly ch: ClickHouseService,
    private readonly coverage: FeatureCoverageService,
  ) {}

  /** The newest row of an issuance, `state_known = 0` too; `undefined` without a row. */
  async issuance(id: string): Promise<StoredMptIssuance | undefined> {
    if (!this.coverage.isAvailable('mpt')) return undefined;
    const [row] = await this.ch.query<IssuanceRead>(
      `SELECT ${ISSUANCE_COLUMNS}
         FROM ${Table.MptIssuances}
        WHERE mpt_issuance_id = {id:String}
        ORDER BY mpt_issuance_id, version DESC
        LIMIT 1 BY mpt_issuance_id`,
      { id },
    );
    return row === undefined ? undefined : storedOf(row);
  }

  /** The newest row of each of the issuances that have one, by ID. */
  async issuances(ids: readonly string[]): Promise<Map<string, StoredMptIssuance>> {
    if (ids.length === 0 || !this.coverage.isAvailable('mpt')) return new Map();
    const rows = await this.ch.query<IssuanceRead>(
      `SELECT ${ISSUANCE_COLUMNS}
         FROM ${Table.MptIssuances}
        WHERE mpt_issuance_id IN {ids:Array(String)}
        ORDER BY mpt_issuance_id, version DESC
        LIMIT 1 BY mpt_issuance_id`,
      { ids: [...new Set(ids)] },
    );
    return new Map(rows.map((row) => [row.mpt_issuance_id, storedOf(row)]));
  }
}
