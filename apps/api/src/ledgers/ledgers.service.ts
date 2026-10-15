import { ClickHouseService, isoTimeToUnixSeconds, Table, toClickHouseDateTime } from '@gatehub/data-api-shared';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { CommonQueryDto } from '../common/query.dto';
import { keysetClause, nextMarker, orderByClause, SortKey } from '../common/pagination';
import { listResponse, toIso } from '../common/response';

const SORT_KEYS: SortKey[] = [{ column: 'close_time', type: 'DateTime' }, { column: 'ledger_index', type: 'UInt32' }];

interface LedgerRow {
  ledger_index: number;
  ledger_hash: string;
  parent_hash: string;
  account_hash: string;
  transaction_hash: string;
  total_coins: string;
  close_time: string;
  close_time_human: string;
  close_time_resolution: number;
  tx_count: number;
}

const SELECT = `ledger_index, ledger_hash, parent_hash, account_hash, transaction_hash, total_coins,
  close_time, close_time_human, close_time_resolution, tx_count`;

@Injectable()
export class LedgersService {
  constructor(private readonly ch: ClickHouseService) {}

  async getLedgers(options: CommonQueryDto) {
    const where: string[] = [];
    const params: Record<string, unknown> = { limit: options.limit };

    const startUnix = isoTimeToUnixSeconds(options.start);
    const endUnix = isoTimeToUnixSeconds(options.end);
    if (startUnix !== undefined) {
      where.push('close_time >= {start:DateTime}');
      params.start = toClickHouseDateTime(startUnix);
    }
    if (endUnix !== undefined) {
      where.push('close_time <= {end:DateTime}');
      params.end = toClickHouseDateTime(endUnix);
    }

    const keyset = keysetClause(SORT_KEYS, options.descending, options.marker);
    if (keyset.clause) {
      where.push(keyset.clause);
      Object.assign(params, keyset.params);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = await this.ch.query<LedgerRow>(
      `SELECT ${SELECT} FROM ${Table.Ledgers} ${whereSql}
       ORDER BY ${orderByClause(SORT_KEYS, options.descending)} LIMIT {limit:UInt32}`,
      params,
    );
    const marker = nextMarker(rows as unknown as Record<string, unknown>[], SORT_KEYS, options.limit);
    return listResponse('ledgers', rows.map((r) => this.format(r)), marker);
  }

  async getLedger(identifier: string) {
    let where: string;
    const params: Record<string, unknown> = {};

    if (/^\d+$/.test(identifier)) {
      where = 'ledger_index = {id:UInt32}';
      params.id = Number(identifier);
    } else if (/^[0-9a-fA-F]{64}$/.test(identifier)) {
      where = 'ledger_hash = {id:String}';
      params.id = identifier.toUpperCase();
    } else if (!Number.isNaN(Date.parse(identifier))) {
      where = 'close_time >= {id:DateTime}';
      params.id = toClickHouseDateTime(isoTimeToUnixSeconds(identifier)!);
    } else {
      throw new BadRequestException('Invalid ledger identifier (expected index, 64-char hash, or ISO date).');
    }

    const row = await this.ch.queryOne<LedgerRow>(
      `SELECT ${SELECT} FROM ${Table.Ledgers} FINAL WHERE ${where} ORDER BY ledger_index ASC LIMIT 1`,
      params,
    );
    if (!row) {
      throw new NotFoundException('ledger-not-found');
    }
    return { result: 'success', ledger: this.format(row) };
  }

  private format(r: LedgerRow) {
    return {
      ledger_hash: r.ledger_hash,
      ledger_index: r.ledger_index,
      parent_hash: r.parent_hash,
      total_coins: r.total_coins,
      close_time_res: r.close_time_resolution,
      account_hash: r.account_hash,
      transaction_hash: r.transaction_hash,
      close_time: toIso(r.close_time),
      close_time_human: r.close_time_human,
      tx_count: r.tx_count,
    };
  }
}
