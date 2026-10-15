import { ClickHouseService, isoTimeToUnixSeconds, Table, toClickHouseDateTime, View } from '@gatehub/data-api-shared';
import { BadRequestException, Injectable } from '@nestjs/common';
import { TopCurrenciesQueryDto, VolumeQueryDto } from './network.dto';

@Injectable()
export class NetworkService {
  constructor(private readonly ch: ClickHouseService) {}

  private resolveCurrency(currency?: string, issuer?: string): { currency: string; issuer?: string } {
    const cur = currency ?? 'XRP';
    if (cur !== 'XRP' && !issuer) {
      throw new BadRequestException('issuer is required for non-XRP currencies');
    }
    if (cur === 'XRP' && issuer) {
      throw new BadRequestException('issuer cannot be set for XRP');
    }
    return { currency: cur, issuer };
  }

  async getPaymentVolume(options: VolumeQueryDto & { start?: string; end?: string }) {
    const { currency, issuer } = this.resolveCurrency(options.currency, options.issuer);
    const params: Record<string, unknown> = { currency, issuer: issuer ?? '' };
    const dateFilter = this.dayFilter(options.start, options.end, params);

    const row = await this.ch.queryOne<{ total: string; count: string }>(
      `SELECT sum(total_amount) AS total, sum(payment_count) AS count
       FROM ${View.PaymentVolumeDaily}
       WHERE currency = {currency:String} AND issuer = {issuer:String} ${dateFilter}`,
      params,
    );

    return {
      result: 'success',
      data: { currency, ...(issuer ? { issuer } : {}), totalAmount: Number(row?.total ?? 0), count: Number(row?.count ?? 0) },
    };
  }

  async getExchangeVolume(options: VolumeQueryDto & { start?: string; end?: string }) {
    const { currency, issuer } = this.resolveCurrency(options.currency, options.issuer);
    const params: Record<string, unknown> = { currency, issuer: issuer ?? '' };
    const dateFilter = this.dayFilter(options.start, options.end, params);

    const row = await this.ch.queryOne<{ total: string; count: string }>(
      `SELECT sum(total_base_amount) AS total, sum(trade_count) AS count
       FROM ${View.ExchangeVolumeDaily}
       WHERE base_currency = {currency:String} AND base_issuer = {issuer:String} ${dateFilter}`,
      params,
    );

    return {
      result: 'success',
      data: { currency, ...(issuer ? { issuer } : {}), totalAmount: Number(row?.total ?? 0), count: Number(row?.count ?? 0) },
    };
  }

  async getTopCurrencies(options: TopCurrenciesQueryDto) {
    const rows = await this.ch.query<{ issuer: string; currency: string; trustlines: string; total_balance: string }>(
      // Dedup trustlines to their latest balance via argMax (instead of FINAL, which
      // merges the whole table per query and OOMs under concurrency).
      `SELECT issuer, currency, uniqExact(counterparty) AS trustlines, sum(latest_balance) AS total_balance
       FROM (
         SELECT issuer, currency, counterparty, argMax(balance, ledger_index) AS latest_balance
         FROM ${Table.Issuers}
         GROUP BY issuer, currency, counterparty
       )
       WHERE latest_balance > 0
       GROUP BY issuer, currency
       ORDER BY trustlines ${options.descending ? 'DESC' : 'ASC'}
       LIMIT {limit:UInt32}`,
      { limit: options.limit },
    );

    const currencies = rows.map((r) => ({
      issuer: r.issuer,
      currency: r.currency,
      trustlines: Number(r.trustlines),
      totalBalance: Number(r.total_balance),
    }));
    return { result: 'success', count: currencies.length, currencies };
  }

  private dayFilter(start: string | undefined, end: string | undefined, params: Record<string, unknown>): string {
    const parts: string[] = [];
    const s = isoTimeToUnixSeconds(start);
    const e = isoTimeToUnixSeconds(end);
    if (s !== undefined) {
      parts.push('day >= toDate({start:DateTime})');
      params.start = toClickHouseDateTime(s);
    }
    if (e !== undefined) {
      parts.push('day <= toDate({end:DateTime})');
      params.end = toClickHouseDateTime(e);
    }
    return parts.length ? `AND ${parts.join(' AND ')}` : '';
  }
}
