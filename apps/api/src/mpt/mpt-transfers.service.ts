import { ClickHouseService, MptTransferKind, readDistinctPage, Table } from '@gatehub/data-api-shared';
import { Injectable } from '@nestjs/common';
import { LedgerRangeResolver } from '../common/ledger-range.service';
import { columnsOf, decodeMarker, keysetClause, KeysetKey, KeyValue, paginate } from '../common/pagination';
import { StoredMptTransfer } from './mpt-objects';

/** The key of a list, which is the ORDER BY of `mpt_issuance_transfers` once the issuance is fixed. */
const TRANSFER_KEYS: KeysetKey[] = [
  { column: 'ledger_index', type: 'UInt32' },
  { column: 'tx_index', type: 'UInt32' },
];

const TRANSFER_COLUMNS = `ledger_index, tx_index, tx_hash, toUnixTimestamp(close_time) AS close_unix, tx_type, kind, source, destination,
       toString(amount) AS amount_text, toString(fee) AS fee_text`;

/** `[ledger_index, tx_index]` of a marker of the transfers, or `undefined` for the first page; else 400 `invalid marker`. */
export function decodeMptTransfersMarker(marker: string | undefined): KeyValue[] | undefined {
  return decodeMarker(marker, TRANSFER_KEYS);
}

/** What a page of the transfers is asked for; the values are already validated. */
export interface MptTransfersQuery {
  /** Inclusive: the first ledger that closed at or after it starts the list. */
  start?: Date;
  /** Exclusive; without it the list runs to the newest committed ledger. */
  endExclusive?: Date;
  kinds?: MptTransferKind[];
  /** Only the rows with this account as source or destination. */
  account?: string;
  descending: boolean;
  limit: number;
  after?: KeyValue[];
}

/**
 * The transfers of an issuance (spec 7.4): a `readDistinctPage` of `mpt_issuance_transfers`, in the order of its key, each row once,
 * `kind` and `account` being conditions of the capped read itself. The range of ledgers comes from `ledgers`, so nothing above the
 * committed head is read.
 */
@Injectable()
export class MptTransfersService {
  constructor(
    private readonly ch: ClickHouseService,
    private readonly ranges: LedgerRangeResolver,
  ) {}

  /** One page, in the order asked for, with the marker of the next page when there is one. */
  async page(id: string, q: MptTransfersQuery): Promise<{ rows: StoredMptTransfer[]; marker?: string }> {
    const range = await this.ranges.resolve(q.start, q.endExclusive);
    if (range === null) return { rows: [] };
    const cursor = keysetClause(TRANSFER_KEYS, q.descending, q.after);
    const rows = await readDistinctPage<StoredMptTransfer>(this.ch, {
      columns: TRANSFER_COLUMNS,
      table: Table.MptIssuanceTransfers,
      where: [
        'mpt_issuance_id = {id:String}',
        'ledger_index BETWEEN {min:UInt32} AND {max:UInt32}',
        ...(q.kinds ? ['kind IN {kinds:Array(String)}'] : []),
        ...(q.account !== undefined ? ['(source = {account:String} OR destination = {account:String})'] : []),
        ...(cursor.clause !== '' ? [cursor.clause] : []),
      ],
      orderBy: ['mpt_issuance_id', ...columnsOf(TRANSFER_KEYS)],
      unique: columnsOf(TRANSFER_KEYS),
      descending: q.descending,
      params: {
        id,
        min: range.min,
        max: range.max,
        ...(q.kinds && { kinds: q.kinds }),
        ...(q.account !== undefined && { account: q.account }),
        ...cursor.params,
      },
      limit: q.limit + 1,
    });
    return paginate(rows, q.limit, (row) => [row.ledger_index, row.tx_index]);
  }
}
