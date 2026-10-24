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
  /** At most this many lines: a page. `linesAll` reads every line, page by page. */
  limit: number;
}

/** The key the lines are ordered and paged by. */
export const TRUST_LINE_KEYS: KeysetKey[] = [
  { column: 'counterparty', type: 'String' },
  { column: 'currency', type: 'String' },
];

/** The lines `linesAll` reads at a time: the largest page of `/trustlines`. */
export const TRUST_LINES_PAGE = 1000;

/** The least room of a read beyond the lines it wants. */
const MIN_ROOM = 16;
/** How much a read grows after one that ended at its cap without a whole line to list. */
const GROWTH = 4;
const MAX_UINT32 = 4_294_967_295;

/** One line as a read groups it: its newest row in the rows read, and how many rows of it were read. */
interface GroupedLine {
  counterparty: string;
  currency: string;
  /** The rows of the line the read took (rows written twice count twice). */
  n: number | string;
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
  deleted: number;
}

// The newest row of a line: the whole key of its change. Rows written twice are equal, so either one.
const NEWEST = '(ledger_index, tx_index, node_index)';
const STATE_COLUMNS = [
  'balance',
  '`limit`',
  'limit_peer',
  'no_ripple',
  'no_ripple_peer',
  'authorized',
  'peer_authorized',
  'freeze',
  'peer_freeze',
  'quality_in',
  'quality_out',
  'deleted',
];

/**
 * The trust lines of an account at a ledger, from the trust line state history (`trust_line_states`; ADR-0015): for
 * each (counterparty, currency) of the account, its newest row at or before the ledger, unless that row deleted the line.
 * A line with a zero balance is a line. The lines come ordered by (counterparty, currency).
 *
 * The ledger must be one the state tables cover (`StateLedgerService.resolve`, `latest`); this service does not check.
 * It is the read of `/v2/accounts/:address/trustlines`, shared by the trust lines of `/balances` at a historical
 * ledger (a page, or every line with `linesAll`, the same filters).
 *
 * A read is bounded (clickhouse.md "Reading a page", ADR-0003): an inner select reads the account's rows in the order of
 * the table's key, `(account, counterparty, currency, ledger_index, ...)`, with a plain `LIMIT` (so ClickHouse stops
 * after that many rows), and an outer one groups them by line, keeping each line's newest row (`argMax` by the key of
 * the change). The rows of a line are consecutive in that order, so every line the read took is whole except, when the
 * read stopped at its cap, the last one: that one is read again by the next read, which starts after the last whole
 * line, with more room. So a page costs about the rows of its lines, and the history of a line is read whole once.
 */
@Injectable()
export class TrustLinesService {
  constructor(private readonly ch: ClickHouseService) {}

  /** At most `q.limit` lines, after `q.after`. */
  async linesAt(q: TrustLinesQuery): Promise<TrustLine[]> {
    const out: TrustLine[] = [];
    let after = q.after;
    let cap = q.limit + Math.max(q.limit, MIN_ROOM);
    while (out.length < q.limit) {
      const groups = await this.read(q, after, cap);
      const read = groups.reduce((sum, g) => sum + Number(g.n), 0);
      // a read that stopped at its cap may have cut its last line: that one is read again
      const capped = read >= cap && cap < MAX_UINT32;
      const whole = capped ? groups.slice(0, -1) : groups;
      let listed = 0;
      for (const g of whole) {
        if (g.deleted !== 0) continue;
        listed++;
        if (out.length < q.limit) out.push(lineOf(g));
      }
      if (!capped || out.length >= q.limit) break;
      const last = whole[whole.length - 1];
      if (last === undefined || listed === 0) {
        // one line, or deleted ones only, filled the read: more room
        cap = Math.min(cap * GROWTH, MAX_UINT32);
      } else {
        // the rest, at as many rows a listed line as this read took, with room
        const rows = read - Number(groups[groups.length - 1].n);
        const remaining = q.limit - out.length;
        cap = Math.min(Math.ceil((remaining * rows) / listed) + Math.max(remaining, MIN_ROOM), MAX_UINT32);
      }
      if (last !== undefined) after = [last.counterparty, last.currency];
    }
    return out;
  }

  /** Every line (`q.limit` is ignored), read `TRUST_LINES_PAGE` lines at a time. */
  async linesAll(q: Omit<TrustLinesQuery, 'limit'>): Promise<TrustLine[]> {
    const out: TrustLine[] = [];
    let after = q.after;
    for (;;) {
      const page = await this.linesAt({ ...q, after, limit: TRUST_LINES_PAGE });
      out.push(...page);
      if (page.length < TRUST_LINES_PAGE) return out;
      const last = page[page.length - 1];
      after = [last.counterparty, last.currency];
    }
  }

  /** The lines of at most `cap` rows of the account after `after`, each with its newest row among them. */
  private read(q: Omit<TrustLinesQuery, 'after'>, after: [string, string] | undefined, cap: number) {
    const where = ['account = {address:String}', 'ledger_index <= {ledgerIndex:UInt32}'];
    const params: Record<string, unknown> = { address: q.address, ledgerIndex: q.ledgerIndex, cap };
    if (q.currency !== undefined) {
      where.push('currency = {currency:String}');
      params.currency = q.currency;
    }
    if (q.counterparty !== undefined) {
      where.push('counterparty = {counterparty:String}');
      params.counterparty = q.counterparty;
    }
    const keyset = keysetClause(TRUST_LINE_KEYS, false, after);
    if (keyset.clause) where.push(keyset.clause);
    Object.assign(params, keyset.params);

    const names = STATE_COLUMNS.map((c) => c.replace(/`/g, ''));
    return this.ch.query<GroupedLine>(
      `SELECT counterparty, currency, n, ${names.map((c, i) => `s.${i + 1} AS \`${c}\``).join(', ')}
         FROM (
           SELECT counterparty, currency, count() AS n, argMax((${STATE_COLUMNS.join(', ')}), ${NEWEST}) AS s
             FROM (
               SELECT counterparty, currency, ledger_index, tx_index, node_index, ${STATE_COLUMNS.join(', ')}
                 FROM ${Table.TrustLineStates}
                WHERE ${where.join(' AND ')}
                ORDER BY account, counterparty, currency, ledger_index, tx_index, node_index
                LIMIT {cap:UInt32}
             )
            GROUP BY counterparty, currency
         )
        ORDER BY counterparty, currency`,
      params,
    );
  }
}

function lineOf(r: GroupedLine): TrustLine {
  return {
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
  };
}
