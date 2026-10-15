import { ClickHouseService, isoTimeToUnixSeconds, Table, toClickHouseDateTime } from '@gatehub/data-api-shared';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import BigNumber from 'bignumber.js';
import * as xrpl from 'xrpl';
import { CacheService } from '../common/cache.service';
import { CommonQueryDto } from '../common/query.dto';
import { keysetClause, nextMarker, orderByClause, SortKey } from '../common/pagination';
import { listResponse, toIso } from '../common/response';
import { API_CONFIG, ApiConfig } from '../config/api.config';
import { XrplService } from '../xrpl/xrpl.service';
import {
  AccountBalanceChangesQueryDto,
  AccountBalancesQueryDto,
  AccountOrdersQueryDto,
  AccountPaymentsQueryDto,
  AccountReportsQueryDto,
  AccountTransactionsQueryDto,
} from './accounts.dto';

const TX_KEYS: SortKey[] = [
  { column: 'date', type: 'DateTime' },
  { column: 'ledger_index', type: 'UInt32' },
  { column: 'tx_index', type: 'UInt16' },
];

const OrderFlags = { Passive: 0x00010000, Sell: 0x00020000 };

@Injectable()
export class AccountsService {
  constructor(
    private readonly ch: ClickHouseService,
    private readonly xrpl: XrplService,
    private readonly cache: CacheService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  async getAccounts(options: CommonQueryDto) {
    const where: string[] = [];
    const params: Record<string, unknown> = { limit: options.limit };
    this.timeWindow(where, params, options.start, options.end);
    const keyset = keysetClause([{ column: 'date', type: 'DateTime' }, { column: 'ledger_index', type: 'UInt32' }], options.descending, options.marker);
    if (keyset.clause) {
      where.push(keyset.clause);
      Object.assign(params, keyset.params);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = await this.ch.query<Record<string, unknown>>(
      `SELECT account, parent, balance, date, ledger_index, tx_index, tx_hash
       FROM ${Table.AccountsCreated} ${whereSql}
       ORDER BY ${orderByClause([{ column: 'date', type: 'DateTime' }, { column: 'ledger_index', type: 'UInt32' }], options.descending)}
       LIMIT {limit:UInt32}`,
      params,
    );
    const marker = nextMarker(rows, [{ column: 'date', type: 'DateTime' }, { column: 'ledger_index', type: 'UInt32' }], options.limit);
    return listResponse('accounts', rows.map((r) => ({ ...r, date: toIso(r.date as string) })), marker);
  }

  async getAccount(address: string) {
    const row = await this.ch.queryOne<Record<string, unknown>>(
      `SELECT account, parent, balance, date, ledger_index, tx_index, tx_hash
       FROM ${Table.AccountsCreated} FINAL WHERE account = {a:String} LIMIT 1`,
      { a: address },
    );
    if (!row) throw new NotFoundException('account-not-found');
    return { result: 'success', account: { ...row, date: toIso(row.date as string) } };
  }

  async getBalanceChanges(address: string, options: AccountBalanceChangesQueryDto) {
    const where = ['account = {a:String}'];
    const params: Record<string, unknown> = { a: address, limit: options.limit };
    if (options.currency) {
      where.push('currency = {currency:String}');
      params.currency = options.currency;
    }
    if (options.counterparty) {
      where.push('counterparty = {cp:String}');
      params.cp = options.counterparty;
    }
    this.timeWindow(where, params, options.start, options.end);
    const keys: SortKey[] = [{ column: 'date', type: 'DateTime' }, { column: 'ledger_index', type: 'UInt32' }, { column: 'node_index', type: 'Int16' }];
    const keyset = keysetClause(keys, options.descending, options.marker);
    if (keyset.clause) {
      where.push(keyset.clause);
      Object.assign(params, keyset.params);
    }
    const rows = await this.ch.query<Record<string, unknown>>(
      `SELECT account, counterparty, currency, change, final_balance, type, date, ledger_index, tx_index, node_index, tx_hash
       FROM ${Table.BalanceChanges} WHERE ${where.join(' AND ')}
       ORDER BY ${orderByClause(keys, options.descending)} LIMIT {limit:UInt32}`,
      params,
    );
    const marker = nextMarker(rows, keys, options.limit);
    return listResponse('balance_changes', rows.map((r) => ({ ...r, date: toIso(r.date as string) })), marker);
  }

  async getAccountPayments(address: string, options: AccountPaymentsQueryDto) {
    const where: string[] = [];
    const params: Record<string, unknown> = { a: address, limit: options.limit };
    const type = options.type ?? 'both';
    if (type === 'sent') where.push('source = {a:String}');
    else if (type === 'received') where.push('destination = {a:String}');
    else where.push('(source = {a:String} OR destination = {a:String})');

    if (options.currency) {
      where.push('currency = {currency:String}');
      params.currency = options.currency;
    }
    if (options.issuer) {
      where.push('issuer = {issuer:String}');
      params.issuer = options.issuer;
    }
    if (options.source_tag !== undefined) {
      where.push('source_tag = {st:UInt32}');
      params.st = options.source_tag;
    }
    if (options.destination_tag !== undefined) {
      where.push('destination_tag = {dt:UInt32}');
      params.dt = options.destination_tag;
    }
    this.timeWindow(where, params, options.start, options.end);
    const keyset = keysetClause(TX_KEYS, options.descending, options.marker);
    if (keyset.clause) {
      where.push(keyset.clause);
      Object.assign(params, keyset.params);
    }
    const rows = await this.ch.query<Record<string, unknown>>(
      `SELECT ctid, tx_hash, source, destination, currency, issuer, amount, delivered_amount,
              source_currency, fee, source_tag, destination_tag, date, ledger_index, tx_index
       FROM ${Table.Payments} WHERE ${where.join(' AND ')}
       ORDER BY ${orderByClause(TX_KEYS, options.descending)} LIMIT {limit:UInt32}`,
      params,
    );
    const marker = nextMarker(rows, TX_KEYS, options.limit);
    return listResponse('payments', rows.map((r) => ({ ...r, date: toIso(r.date as string) })), marker);
  }

  async getAccountTransactions(address: string, options: AccountTransactionsQueryDto) {
    const where = ['account = {a:String}'];
    const params: Record<string, unknown> = { a: address, limit: options.limit };
    if (options.type) {
      where.push('tx_type = {type:String}');
      params.type = options.type;
    }
    if (options.result) {
      where.push('result = {result:String}');
      params.result = options.result;
    }
    if (options.min_ledger !== undefined) {
      where.push('ledger_index >= {minl:UInt32}');
      params.minl = options.min_ledger;
    }
    if (options.max_ledger !== undefined) {
      where.push('ledger_index <= {maxl:UInt32}');
      params.maxl = options.max_ledger;
    }
    this.timeWindow(where, params, options.start, options.end);
    const keyset = keysetClause(TX_KEYS, options.descending, options.marker);
    if (keyset.clause) {
      where.push(keyset.clause);
      Object.assign(params, keyset.params);
    }
    const rows = await this.ch.query<Record<string, unknown>>(
      `SELECT hash, ledger_index, tx_index, tx_type AS type, result, date, tx_json
       FROM ${Table.Transactions} WHERE ${where.join(' AND ')}
       ORDER BY ${orderByClause(TX_KEYS, options.descending)} LIMIT {limit:UInt32}`,
      params,
    );
    const marker = nextMarker(rows, TX_KEYS, options.limit);
    const transactions = rows.map((r) => ({
      hash: r.hash,
      ledger_index: r.ledger_index,
      type: r.type,
      result: r.result,
      date: toIso(r.date as string),
      tx: JSON.parse(r.tx_json as string),
    }));
    return listResponse('transactions', transactions, marker);
  }

  async getAccountExchanges(address: string, options: CommonQueryDto) {
    const where = ['(buyer = {a:String} OR seller = {a:String} OR taker = {a:String})'];
    const params: Record<string, unknown> = { a: address, limit: options.limit };
    this.timeWindow(where, params, options.start, options.end);
    const keyset = keysetClause(TX_KEYS, options.descending, options.marker);
    if (keyset.clause) {
      where.push(keyset.clause);
      Object.assign(params, keyset.params);
    }
    const rows = await this.ch.query<Record<string, unknown>>(
      `SELECT base_currency, base_issuer, base_amount, counter_currency, counter_issuer, counter_amount,
              rate, buyer, seller, taker, provider, date, ledger_index, tx_index, tx_hash
       FROM ${Table.Exchanges} WHERE ${where.join(' AND ')}
       ORDER BY ${orderByClause(TX_KEYS, options.descending)} LIMIT {limit:UInt32}`,
      params,
    );
    const marker = nextMarker(rows, TX_KEYS, options.limit);
    return listResponse('exchanges', rows.map((r) => ({ ...r, date: toIso(r.date as string) })), marker);
  }

  /** Live trustline + XRP balances from the XRPL node (not the index). Short-TTL cached. */
  async getAccountBalances(address: string, options: AccountBalancesQueryDto) {
    const key = `balances:${address}:${options.ledger ?? 'validated'}:${options.currency ?? ''}`;
    return this.cache.wrap(key, this.config.liveCacheTtlMs, () => this.fetchAccountBalances(address, options));
  }

  private async fetchAccountBalances(address: string, options: AccountBalancesQueryDto) {
    const ledgerIndex = options.ledger ?? 'validated';
    const [info, lines] = await Promise.all([
      this.xrpl.request<xrpl.AccountInfoResponse>({ command: 'account_info', account: address, ledger_index: ledgerIndex as xrpl.LedgerIndex }),
      this.xrpl.request<xrpl.AccountLinesResponse>({ command: 'account_lines', account: address, ledger_index: ledgerIndex as xrpl.LedgerIndex }),
    ]);

    const trustlines = lines.result.lines
      .filter((l) => !options.currency || l.currency === options.currency)
      .map((l) => ({ currency: l.currency, counterparty: l.account, value: l.balance }));
    const balances = [
      ...(!options.currency || options.currency === 'XRP'
        ? [{ currency: 'XRP', value: xrpl.dropsToXrp(info.result.account_data.Balance).toString() }]
        : []),
      ...trustlines,
    ];
    return { result: 'success', ledger_index: info.result.ledger_index, count: balances.length, balances };
  }

  /** Live open orders from the XRPL node. Short-TTL cached. */
  async getAccountOrders(address: string, options: AccountOrdersQueryDto) {
    const key = `orders:${address}:${options.ledger ?? 'validated'}:${options.limit}`;
    return this.cache.wrap(key, this.config.liveCacheTtlMs, () => this.fetchAccountOrders(address, options));
  }

  private async fetchAccountOrders(address: string, options: AccountOrdersQueryDto) {
    const req: xrpl.AccountOffersRequest = { command: 'account_offers', account: address, limit: options.limit };
    if (options.ledger && options.ledger !== 'validated') {
      if (/^\d+$/.test(options.ledger)) req.ledger_index = Number(options.ledger);
      else req.ledger_hash = options.ledger;
    } else {
      req.ledger_index = 'validated';
    }
    const response = await this.xrpl.request<xrpl.AccountOffersResponse>(req);
    const orders = (response.result.offers ?? []).map((offer) => this.parseOrder(address, offer));
    return { result: 'success', count: orders.length, orders };
  }

  async getAccountTransactionStats(address: string, options: CommonQueryDto) {
    const where = ['account = {a:String}'];
    const params: Record<string, unknown> = { a: address };
    this.timeWindow(where, params, options.start, options.end);
    const rows = await this.ch.query<{ type: string; count: string }>(
      `SELECT tx_type AS type, count() AS count FROM ${Table.AffectedAccounts}
       WHERE ${where.join(' AND ')} GROUP BY type ORDER BY count DESC`,
      params,
    );
    const stats = rows.reduce<Record<string, number>>((acc, r) => ((acc[r.type] = Number(r.count)), acc), {});
    return { result: 'success', stats };
  }

  /**
   * Per-day sent/received payment report for an account. Unlike the old
   * implementation this does NOT swallow errors as a fake-success response and
   * does NOT truncate to the first 1000 docs — totals are exact (aggregated in DB).
   */
  async getAccountReports(address: string, options: AccountReportsQueryDto) {
    const where = ['(source = {a:String} OR destination = {a:String})'];
    const params: Record<string, unknown> = { a: address };
    this.timeWindow(where, params, options.start, options.end);

    const rows = await this.ch.query<{ day: string; direction: string; currency: string; total: string; count: string }>(
      `SELECT toString(toDate(date)) AS day,
              if(source = {a:String}, 'sent', 'received') AS direction,
              currency,
              sum(amount) AS total,
              count() AS count
       FROM ${Table.Payments}
       WHERE ${where.join(' AND ')}
       GROUP BY day, direction, currency
       ORDER BY day ASC`,
      params,
    );

    const byDay = new Map<string, { date: string; sent: Record<string, number>; received: Record<string, number>; payment_count: number }>();
    for (const r of rows) {
      const entry = byDay.get(r.day) ?? { date: r.day, sent: {}, received: {}, payment_count: 0 };
      const bucket = r.direction === 'sent' ? entry.sent : entry.received;
      bucket[r.currency] = (bucket[r.currency] ?? 0) + Number(r.total);
      entry.payment_count += Number(r.count);
      byDay.set(r.day, entry);
    }
    const reports = [...byDay.values()];
    return { result: 'success', count: reports.length, reports };
  }

  private parseOrder(address: string, order: xrpl.AccountOffer) {
    const direction = (order.flags & OrderFlags.Sell) === 0 ? 'buy' : 'sell';
    const takerGets = order.taker_gets;
    const takerPays = order.taker_pays;
    const amountValue = (a: xrpl.Amount): string => (typeof a === 'string' ? xrpl.dropsToXrp(a).toString() : a.value);
    const quality = order.quality
      ? new BigNumber(order.quality).toString()
      : new BigNumber(amountValue(takerPays)).dividedBy(amountValue(takerGets)).toString();
    return {
      specification: {
        direction,
        quantity: direction === 'buy' ? takerPays : takerGets,
        totalPrice: direction === 'buy' ? takerGets : takerPays,
        passive: (order.flags & OrderFlags.Passive) !== 0 || undefined,
        expirationTime: typeof order.expiration === 'number' ? xrpl.rippleTimeToISOTime(order.expiration) : undefined,
      },
      properties: { maker: address, sequence: order.seq, makerExchangeRate: quality },
    };
  }

  private timeWindow(where: string[], params: Record<string, unknown>, start?: string, end?: string): void {
    const s = isoTimeToUnixSeconds(start);
    const e = isoTimeToUnixSeconds(end);
    if (s !== undefined) {
      where.push('date >= {start:DateTime}');
      params.start = toClickHouseDateTime(s);
    }
    if (e !== undefined) {
      where.push('date <= {end:DateTime}');
      params.end = toClickHouseDateTime(e);
    }
  }
}
