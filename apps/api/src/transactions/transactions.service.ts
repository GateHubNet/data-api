import { ClickHouseService, isoTimeToUnixSeconds, Table, toClickHouseDateTime } from '@gatehub/data-api-shared';
import { Injectable, NotFoundException } from '@nestjs/common';
import * as xrpl from 'xrpl';
import { keysetClause, nextMarker, orderByClause, SortKey } from '../common/pagination';
import { listResponse, toIso } from '../common/response';
import { TransactionHashQueryDto, TransactionsQueryDto } from './transactions.dto';

const SORT_KEYS: SortKey[] = [
  { column: 'date', type: 'DateTime' },
  { column: 'ledger_index', type: 'UInt32' },
  { column: 'tx_index', type: 'UInt16' },
];

interface TxRow {
  ctid: string;
  hash: string;
  ledger_index: number;
  tx_index: number;
  tx_type: string;
  account: string;
  result: string;
  date: string;
  tx_json: string;
  meta_json: string;
}

@Injectable()
export class TransactionsService {
  constructor(private readonly ch: ClickHouseService) {}

  async getTransactions(options: TransactionsQueryDto) {
    const where: string[] = [];
    const params: Record<string, unknown> = { limit: options.limit };

    if (options.type) {
      where.push('tx_type = {type:String}');
      params.type = options.type;
    }
    if (options.result) {
      where.push('result = {result:String}');
      params.result = options.result;
    }
    const startUnix = isoTimeToUnixSeconds(options.start);
    const endUnix = isoTimeToUnixSeconds(options.end);
    if (startUnix !== undefined) {
      where.push('date >= {start:DateTime}');
      params.start = toClickHouseDateTime(startUnix);
    }
    if (endUnix !== undefined) {
      where.push('date <= {end:DateTime}');
      params.end = toClickHouseDateTime(endUnix);
    }

    const keyset = keysetClause(SORT_KEYS, options.descending, options.marker);
    if (keyset.clause) {
      where.push(keyset.clause);
      Object.assign(params, keyset.params);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const sql = `
      SELECT ctid, hash, ledger_index, tx_index, tx_type, account, result, date, tx_json, meta_json
      FROM ${Table.Transactions}
      ${whereSql}
      ORDER BY ${orderByClause(SORT_KEYS, options.descending)}
      LIMIT {limit:UInt32}`;

    const rows = await this.ch.query<TxRow>(sql, params);
    const marker = nextMarker(rows as unknown as Record<string, unknown>[], SORT_KEYS, options.limit);
    const transactions = rows.map((r) => this.format(r));
    return listResponse('transactions', transactions, marker);
  }

  async getTransactionByHash(hash: string, options: TransactionHashQueryDto) {
    const row = await this.ch.queryOne<TxRow>(
      `SELECT ctid, hash, ledger_index, tx_index, tx_type, account, result, date, tx_json, meta_json
       FROM ${Table.Transactions} FINAL WHERE hash = {hash:String} LIMIT 1`,
      { hash },
    );
    if (!row) {
      throw new NotFoundException('transaction-not-found');
    }

    const tx = JSON.parse(row.tx_json);
    const meta = JSON.parse(row.meta_json);
    return {
      result: 'success',
      transaction: {
        hash: row.hash,
        ledger_index: row.ledger_index,
        date: toIso(row.date),
        tx: options.binary ? xrpl.encode(tx) : tx,
        meta: options.binary ? xrpl.encode(meta) : meta,
      },
    };
  }

  private format(r: TxRow) {
    const tx = JSON.parse(r.tx_json);
    return {
      hash: r.hash,
      ledger_index: r.ledger_index,
      tx_index: r.tx_index,
      type: r.tx_type,
      account: r.account,
      result: r.result,
      date: toIso(r.date),
      tx,
    };
  }
}
