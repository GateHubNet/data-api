import { ClickHouseService, Table } from '@gatehub/data-api-shared';
import { Injectable } from '@nestjs/common';
import { badRequest } from '../common/errors';
import { LedgerRangeResolver } from '../common/ledger-range.service';
import { DATE_TOO_OLD, LedgerSelector, LedgerSpec } from './account-ledger';

/** The ledger a live request is about, and the close time to show when a date chose it. */
export interface ResolvedLedger {
  spec: LedgerSpec;
  /** Unix seconds: the close time of the ledger a `date` resolved to. Only a date has one in the response. */
  closeTime?: number;
}

/** The ledger shortcut of a request that names no ledger: the newest validated one (the original asked for the open ledger). */
const DEFAULT_SPEC: LedgerSpec = { ledger_index: 'validated' };

/**
 * Turns the ledger a live request names into the `ledger_index` / `ledger_hash` the node is asked for.
 *
 * A hash wins (`hbase.getLedger` of the original tried it first), then a date, then an index; none is `validated`.
 *  - A hash is forwarded to the node as it is (the original ignored it).
 *  - A date becomes the last ledger this API has stored that closed at or before it, so the node is asked for exactly
 *    that ledger, and its close time is reported. No such ledger (the date is older than the first stored one) is the
 *    400 of a ledger the node does not have.
 *  - An index is forwarded as it is.
 */
@Injectable()
export class LiveLedgerService {
  constructor(
    private readonly ranges: LedgerRangeResolver,
    private readonly ch: ClickHouseService,
  ) {}

  async resolve(selector: LedgerSelector): Promise<ResolvedLedger> {
    if (selector.hash !== undefined) return { spec: { ledger_hash: selector.hash } };
    if (selector.date !== undefined) {
      const index = await this.ranges.ledgerAtOrBefore(selector.date);
      if (index === undefined) throw badRequest(DATE_TOO_OLD);
      return { spec: { ledger_index: index }, closeTime: await this.closeTime(index) };
    }
    return { spec: selector.index === undefined ? DEFAULT_SPEC : { ledger_index: selector.index } };
  }

  /** The close time of a stored ledger, in unix seconds. */
  private async closeTime(ledgerIndex: number): Promise<number | undefined> {
    const [row] = await this.ch.query<{ close_time: number }>(
      `SELECT toUnixTimestamp(close_time) AS close_time FROM ${Table.Ledgers}
        WHERE ledger_index = {ledgerIndex:UInt32} LIMIT 1`,
      { ledgerIndex },
    );
    return row?.close_time;
  }
}
