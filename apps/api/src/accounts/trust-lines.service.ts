import { ClickHouseService, Table } from '@gatehub/data-api-shared';
import { Injectable } from '@nestjs/common';
import { KeysetKey, keysetClause } from '../common/pagination';

/** A trust line of an account at a ledger, from the account's side. */
export interface TrustLine {
  currency: string;
  counterparty: string;
  /** Exact decimal: positive when the counterparty owes the account. */
  balance: string;
  limit: string;
  limit_peer: string;
  no_ripple: boolean;
  no_ripple_peer: boolean;
  authorized: boolean;
  peer_authorized: boolean;
  freeze: boolean;
  peer_freeze: boolean;
  quality_in: number;
  quality_out: number;
}

/** What to read: an account's lines at a stored ledger the state tables cover (`StateLedgerService`). */
export interface TrustLinesQuery {
  address: string;
  ledgerIndex: number;
  currency?: string;
  counterparty?: string;
  /** Only the lines after this (counterparty, currency): the marker of the page before. */
  after?: [string, string];
  /** At most this many lines; none reads them all. */
  limit?: number;
}

/** The key the lines are ordered and paged by. */
export const TRUST_LINE_KEYS: KeysetKey[] = [
  { column: 'counterparty', type: 'String' },
  { column: 'currency', type: 'String' },
];

interface TrustLineRow {
  counterparty: string;
  currency: string;
  balance: string;
  limit: string;
  limit_peer: string;
  no_ripple: number;
  no_ripple_peer: number;
  authorized: number;
  peer_authorized: number;
  freeze: number;
  peer_freeze: number;
  quality_in: number;
  quality_out: number;
}

/**
 * The trust lines of an account at a ledger, from the trust line state history (`trust_line_states`; ADR-0015): for
 * each (counterparty, currency) of the account, its newest row at or before the ledger, unless that row deleted the line.
 * A line with a zero balance is a line. The lines come ordered by (counterparty, currency).
 *
 * The ledger must be one the state tables cover (`StateLedgerService.resolve`, `latest`); this service does not check.
 * It is the read of `/v2/accounts/:address/trustlines`, made to be shared by the trust lines of `/balances` at a
 * historical ledger (a `limit` or none, the same filters).
 *
 * Every row of the account up to the ledger is grouped, so an issuer's read reads its whole line history: see the risk
 * note of the API reference.
 */
@Injectable()
export class TrustLinesService {
  constructor(private readonly ch: ClickHouseService) {}

  async linesAt(q: TrustLinesQuery): Promise<TrustLine[]> {
    const where = ['account = {address:String}', 'ledger_index <= {ledgerIndex:UInt32}'];
    const params: Record<string, unknown> = { address: q.address, ledgerIndex: q.ledgerIndex };
    if (q.currency !== undefined) {
      where.push('currency = {currency:String}');
      params.currency = q.currency;
    }
    if (q.counterparty !== undefined) {
      where.push('counterparty = {counterparty:String}');
      params.counterparty = q.counterparty;
    }
    const after = keysetClause(TRUST_LINE_KEYS, false, q.after);
    if (after.clause) where.push(after.clause);
    Object.assign(params, after.params);
    if (q.limit !== undefined) params.limit = q.limit;

    // The newest row of each line inside (rows written twice are equal, so either one), the deleted lines dropped outside.
    const rows = await this.ch.query<TrustLineRow>(
      `SELECT counterparty, currency, balance, \`limit\`, limit_peer, no_ripple, no_ripple_peer, authorized,
              peer_authorized, freeze, peer_freeze, quality_in, quality_out
         FROM (
           SELECT * FROM ${Table.TrustLineStates}
            WHERE ${where.join(' AND ')}
            ORDER BY counterparty, currency, ledger_index DESC, tx_index DESC, node_index DESC
            LIMIT 1 BY counterparty, currency
         )
        WHERE deleted = 0
        ORDER BY counterparty, currency
        ${q.limit !== undefined ? 'LIMIT {limit:UInt32}' : ''}`,
      params,
    );
    return rows.map((r) => ({
      currency: r.currency,
      counterparty: r.counterparty,
      balance: r.balance,
      limit: r.limit,
      limit_peer: r.limit_peer,
      no_ripple: r.no_ripple === 1,
      no_ripple_peer: r.no_ripple_peer === 1,
      authorized: r.authorized === 1,
      peer_authorized: r.peer_authorized === 1,
      freeze: r.freeze === 1,
      peer_freeze: r.peer_freeze === 1,
      quality_in: r.quality_in,
      quality_out: r.quality_out,
    }));
  }
}
