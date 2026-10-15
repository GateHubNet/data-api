import { ClickHouseService, Table } from '@gatehub/data-api-shared';
import { Injectable } from '@nestjs/common';
import { fmtCloseTimeHuman, fmtTime } from '../common/format';
import { LedgerRangeResolver } from '../common/ledger-range.service';
import { TxObject, TxService } from '../common/tx-object';
import type { LedgerId } from './ledger-identifier';

/** What `getLedger` adds to the ledger: `transactions` as hashes (`transactions=true`) or as transaction objects. */
export interface LedgerOptions {
  /** The hashes of the transactions of the ledger. */
  transactions: boolean;
  /** The transactions as JSON objects. */
  expand: boolean;
  /** The transactions as binary objects; wins over `expand`. */
  binary: boolean;
}

/**
 * A ledger as the Ripple API serves it. Numbers: `ledger_index`, `close_time` (unix seconds) and `parent_close_time`.
 * Everything else is text, because the original read the header from HBase, where every column is a string and only
 * those three were converted (`getLedgerByHash` in `lib/hbase/hbase-thrift/data.js`): `total_coins` (drops),
 * `close_time_human`, `close_time_resolution` and `close_flags`, besides the hashes.
 *
 * The original stored the whole ledger it was given, so the row also had `hash`, `seqNum`, `totalCoins`, `accepted`
 * and `closed`, and the response served them after the others. They carry no information of their own (a ledger of
 * this API is a validated one), but clients of the original may read them.
 */
export interface LedgerObject {
  ledger_hash: string;
  ledger_index: number;
  parent_hash: string;
  total_coins: string;
  close_time: number;
  /** `YYYY-MMM-DD HH:mm:ss`, UTC. */
  close_time_human: string;
  close_time_resolution: string;
  close_flags: string;
  /** Left out when the ledger has none. */
  parent_close_time?: number;
  account_hash: string;
  transaction_hash: string;
  /** = `ledger_hash` */
  hash: string;
  /** = `ledger_index`, as text */
  seqNum: string;
  /** = `total_coins` */
  totalCoins: string;
  /** The text "true": HBase kept `JSON.stringify(true)` of the boolean of rippled. Every served ledger is validated. */
  accepted: 'true';
  /** The text "true", as `accepted`. */
  closed: 'true';
  transactions?: string[] | TxObject[];
}

/** The last validated ledger, as `GET /v2/last_validated` answers (without `result`). */
export interface LastValidated {
  /** A string: the original served the column of its control row as it was stored. */
  ledger_index: string;
  ledger_hash: string;
  parent_hash: string;
  /** `YYYY-MM-DDTHH:mm:ssZ` */
  close_time: string;
}

interface HeaderRow {
  ledger_index: number;
  ledger_hash: string;
  parent_hash: string;
  total_coins: string;
  close_time: number;
  close_time_resolution: number;
  close_flags: number;
  parent_close_time: number;
  account_hash: string;
  transaction_hash: string;
  tx_count: number;
}

// `UInt64` is read as text so that no digit of the total is lost, and the times as unix seconds.
const HEADER_COLUMNS = [
  'ledger_index',
  'ledger_hash',
  'parent_hash',
  'toString(total_coins) AS total_coins',
  'toUnixTimestamp(close_time) AS close_time',
  'close_time_resolution',
  'close_flags',
  'toUnixTimestamp(parent_close_time) AS parent_close_time',
  'account_hash',
  'transaction_hash',
  'tx_count',
].join(', ');

const MAX_UINT32 = 4_294_967_295;

/**
 * The ledgers of the API. A ledger exists once its `ledgers` row does: that row is the commit marker the syncer writes
 * after everything else of the ledger, so a ledger that is half written is not served.
 */
@Injectable()
export class LedgersService {
  constructor(
    private readonly ch: ClickHouseService,
    private readonly ranges: LedgerRangeResolver,
    private readonly txs: TxService,
  ) {}

  /**
   * The ledger with the given identity, `undefined` when there is none. As in the original the hash is looked at first,
   * then the date (the last ledger closed at or before it), then the index; with none of them the latest ledger.
   *
   * `o.binary` and `o.expand` add the transactions as objects (binary wins) and `o.transactions` their hashes, as
   * `getLedgerByHash` does: expand and binary only apply to a ledger that has transactions, and take precedence over
   * `transactions`. A ledger whose transactions are not all stored is an error (the route answers 500).
   */
  async getLedger(id: LedgerId, o: LedgerOptions): Promise<LedgerObject | undefined> {
    const header = await this.header(id);
    if (!header) return undefined;

    let transactions: string[] | TxObject[] | undefined;
    if (header.tx_count > 0 && (o.binary || o.expand)) {
      transactions = await this.transactionObjects(header, o.binary);
    } else if (o.transactions) {
      transactions = await this.transactionHashes(header);
    }

    return {
      ledger_hash: header.ledger_hash,
      ledger_index: header.ledger_index,
      parent_hash: header.parent_hash,
      total_coins: header.total_coins,
      close_time: header.close_time,
      close_time_human: fmtCloseTimeHuman(header.close_time),
      close_time_resolution: String(header.close_time_resolution),
      close_flags: String(header.close_flags),
      // 0 is how the syncer stores a ledger that has no parent close time
      ...(header.parent_close_time > 0 && { parent_close_time: header.parent_close_time }),
      account_hash: header.account_hash,
      transaction_hash: header.transaction_hash,
      hash: header.ledger_hash,
      seqNum: String(header.ledger_index),
      totalCoins: header.total_coins,
      accepted: 'true',
      closed: 'true',
      ...(transactions !== undefined && { transactions }),
    };
  }

  /** The newest committed ledger, `undefined` on an empty database. */
  async getLastValidated(): Promise<LastValidated | undefined> {
    const [row] = await this.ch.query<{
      ledger_index: number;
      ledger_hash: string;
      parent_hash: string;
      close_time: number;
    }>(
      `SELECT ledger_index, ledger_hash, parent_hash, toUnixTimestamp(close_time) AS close_time
         FROM ${Table.Ledgers} ORDER BY ledger_index DESC LIMIT 1`,
    );
    if (!row) return undefined;
    return {
      ledger_index: String(row.ledger_index),
      ledger_hash: row.ledger_hash,
      parent_hash: row.parent_hash,
      close_time: fmtTime(row.close_time),
    };
  }

  private async header(id: LedgerId): Promise<HeaderRow | undefined> {
    if (id.hash !== undefined) {
      // Both lookups must agree: the lookup table is written before the commit marker and names the index.
      const [row] = await this.ch.query<HeaderRow>(
        `SELECT ${HEADER_COLUMNS} FROM ${Table.Ledgers}
          WHERE ledger_index IN (SELECT ledger_index FROM ${Table.LedgerByHash} WHERE ledger_hash = {hash:String})
            AND ledger_hash = {hash:String}
          LIMIT 1`,
        { hash: id.hash },
      );
      return row;
    }

    if (id.date !== undefined) {
      const index = await this.ranges.ledgerAtOrBefore(id.date);
      return index === undefined ? undefined : this.headerByIndex(index);
    }

    if (id.index !== undefined) return this.headerByIndex(id.index);

    const [latest] = await this.ch.query<HeaderRow>(
      `SELECT ${HEADER_COLUMNS} FROM ${Table.Ledgers} ORDER BY ledger_index DESC LIMIT 1`,
    );
    return latest;
  }

  private async headerByIndex(index: number): Promise<HeaderRow | undefined> {
    // an index that no ledger can have; also keeps the parameter inside its type
    if (!Number.isSafeInteger(index) || index < 0 || index > MAX_UINT32) return undefined;
    const [row] = await this.ch.query<HeaderRow>(
      `SELECT ${HEADER_COLUMNS} FROM ${Table.Ledgers} WHERE ledger_index = {index:UInt32} LIMIT 1`,
      { index },
    );
    return row;
  }

  /** The `tx_index` of every stored transaction of the ledger, ascending. */
  private async transactionIndexes(ledgerIndex: number): Promise<number[]> {
    // `LIMIT 1 BY`: a transaction written twice (before the merge) counts once
    const rows = await this.ch.query<{ tx_index: number }>(
      `SELECT tx_index FROM ${Table.Transactions} WHERE ledger_index = {ledgerIndex:UInt32}
        ORDER BY tx_index LIMIT 1 BY tx_index`,
      { ledgerIndex },
    );
    return rows.map((row) => row.tx_index);
  }

  /** The hashes of the transactions of the ledger in transaction order. */
  private async transactionHashes(header: HeaderRow): Promise<string[]> {
    const rows = await this.ch.query<{ hash: string }>(
      `SELECT hash FROM ${Table.Transactions} WHERE ledger_index = {ledgerIndex:UInt32}
        ORDER BY tx_index LIMIT 1 BY tx_index`,
      { ledgerIndex: header.ledger_index },
    );
    this.assertComplete(header, rows.length);
    return rows.map((row) => row.hash);
  }

  /** The transactions of the ledger as the API objects (no `ledger_hash`, which the ledger already carries). */
  private async transactionObjects(header: HeaderRow, binary: boolean): Promise<TxObject[]> {
    const indexes = await this.transactionIndexes(header.ledger_index);
    const rows = await this.txs.fetchByKeys(
      indexes.map((tx_index) => ({ ledger_index: header.ledger_index, tx_index })),
    );
    this.assertComplete(header, rows.length);
    return this.txs.toTxObjects(rows, { binary });
  }

  /**
   * The ledger knows how many transactions it has (`tx_count`, written with the commit marker). Fewer stored ones are a
   * hole in the data, which the original reported as a failure too (`missing transaction: n of m found`); the route
   * turns the error into 500 `unable to retrieve ledger`.
   */
  private assertComplete(header: HeaderRow, found: number): void {
    if (found !== header.tx_count) {
      throw new Error(
        `Ledger ${header.ledger_index} has ${header.tx_count} transactions but ${found} are stored: missing transaction`,
      );
    }
  }
}
