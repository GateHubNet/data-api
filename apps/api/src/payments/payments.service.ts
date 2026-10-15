import { ClickHouseService, isoTimeToUnixSeconds, Table, toClickHouseDateTime } from '@gatehub/data-api-shared';
import { Injectable } from '@nestjs/common';
import { listResponse, toIso } from '../common/response';
import { keysetClause, nextMarker, orderByClause, SortKey } from '../common/pagination';
import { PaymentsQueryDto } from './payments.dto';

const SORT_KEYS: SortKey[] = [
  { column: 'date', type: 'DateTime' },
  { column: 'ledger_index', type: 'UInt32' },
  { column: 'tx_index', type: 'UInt16' },
];

@Injectable()
export class PaymentsService {
  constructor(private readonly ch: ClickHouseService) {}

  async getPayments(options: PaymentsQueryDto) {
    const where: string[] = [];
    const params: Record<string, unknown> = { limit: options.limit };

    if (options.currency) {
      where.push('currency = {currency:String}');
      params.currency = options.currency;
    }
    if (options.issuer) {
      where.push('issuer = {issuer:String}');
      params.issuer = options.issuer;
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
      SELECT ctid, tx_hash, source, destination, currency, issuer, amount, delivered_amount,
             source_currency, max_amount, fee, source_tag, destination_tag, invoice_id,
             date, ledger_index, tx_index, client
      FROM ${Table.Payments}
      ${whereSql}
      ORDER BY ${orderByClause(SORT_KEYS, options.descending)}
      LIMIT {limit:UInt32}`;

    const rows = await this.ch.query<Record<string, unknown>>(sql, params);
    const marker = nextMarker(rows, SORT_KEYS, options.limit);
    const payments = rows.map((r) => ({ ...r, date: toIso(r.date as string) }));
    return listResponse('payments', payments, marker);
  }
}
