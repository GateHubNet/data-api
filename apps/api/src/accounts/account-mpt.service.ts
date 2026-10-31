import { ClickHouseService, isMptIssuanceId, Table } from '@gatehub/data-api-shared';
import { Injectable } from '@nestjs/common';
import { badRequest } from '../common/errors';
import { Coverage, FeatureCoverageService } from '../common/feature-coverage.service';
import { LedgerRangeResolver } from '../common/ledger-range.service';
import { AccountMptObject, StoredAccountMpt, toAccountMpt } from '../mpt/mpt-objects';
import { MptService } from '../mpt/mpt.service';

/**
 * The marker of the holdings, or `undefined` for the first page: the ID of the last row of a page, in upper case, read as it is
 * written and not through `decodeMarker`, since a page ends on an ID that means something to a reader (spec 7.6). Else 400 `invalid marker`.
 */
export function parseHoldingsMarker(marker: string | undefined): string | undefined {
  if (marker === undefined || marker === '') return undefined;
  if (!isMptIssuanceId(marker)) throw badRequest('invalid marker');
  return marker.toUpperCase();
}

/** What a page of the holdings is asked for; the values are already validated. */
export interface AccountMptQuery {
  includeZero: boolean;
  limit: number;
  /** The ID of the last row of the page before. */
  after?: string;
}

/** A page of the holdings: as of the head, with the coverage of the feature. No committed ledger is no head to name. */
export interface AccountMptPage {
  coverage: Coverage;
  head?: { ledger_index: number; close_time: number };
  rows: AccountMptObject[];
  /** The ID of the last row, when there is a next page. */
  marker?: string;
}

/**
 * The holdings of an account (spec 7.6): the account's prefix of `mpt_holder_states` at or below the committed head, the newest state
 * of each of its tokens, then what that state says. The aliases `amount_text` and `escrowed_text` are not `amount` and `escrowed_amount`:
 * the balance condition of the outer SELECT wants the numbers (ruling C20). The state of each ID is what the ledger said at the head,
 * whatever the last run of the `mpt_state` job has seen; the issuance's fields are read for the IDs of the page.
 *
 * On a network without MPT no MPT table is read, and the list is empty and complete.
 */
@Injectable()
export class AccountMptService {
  constructor(
    private readonly ch: ClickHouseService,
    private readonly ranges: LedgerRangeResolver,
    private readonly features: FeatureCoverageService,
    private readonly issuances: MptService,
  ) {}

  /** One page by ID. */
  async page(account: string, q: AccountMptQuery): Promise<AccountMptPage> {
    const [head, coverage] = await Promise.all([this.ranges.latestWithTime(), this.features.coverage('mpt')]);
    if (head === undefined) return { coverage, rows: [] };
    if (!this.features.isAvailable('mpt')) return { coverage, head, rows: [] };

    const stored = await this.states(account, head.ledger_index, q);
    const rows = stored.slice(0, q.limit);
    const found = await this.issuances.issuances(rows.map((row) => row.mpt_issuance_id));
    return {
      coverage,
      head,
      rows: rows.map((row) => toAccountMpt(row, found.get(row.mpt_issuance_id))),
      ...(stored.length > q.limit && { marker: rows[rows.length - 1].mpt_issuance_id }),
    };
  }

  /** The newest state of each token of the account after the marker, `limit + 1` of them. */
  private states(account: string, head: number, q: AccountMptQuery): Promise<StoredAccountMpt[]> {
    return this.ch.query<StoredAccountMpt>(
      `SELECT mpt_issuance_id, toString(amount) AS amount_text, toString(escrowed_amount) AS escrowed_text, flags
         FROM (SELECT mpt_issuance_id, amount, escrowed_amount, flags, deleted
                 FROM ${Table.MptHolderStates}
                WHERE holder = {account:String} AND ledger_index <= {head:UInt32}
                      ${q.after === undefined ? '' : 'AND mpt_issuance_id > {after:String}'}
                ORDER BY mpt_issuance_id, ledger_index DESC, tx_index DESC, node_index DESC
                LIMIT 1 BY mpt_issuance_id)
        WHERE deleted = 0 ${q.includeZero ? '' : 'AND amount + escrowed_amount > 0'}
        ORDER BY mpt_issuance_id
        LIMIT {n:UInt32}`,
      { account, head, n: q.limit + 1, ...(q.after !== undefined && { after: q.after }) },
    );
  }
}
