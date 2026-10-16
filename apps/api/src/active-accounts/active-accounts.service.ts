import {
  Asset,
  canonicalPair,
  ClickHouseService,
  Table,
  VOLUME_SOURCE_COLUMNS,
  volumeColumns,
} from '@gatehub/data-api-shared';
import { Injectable } from '@nestjs/common';
import { LedgerRangeResolver } from '../common/ledger-range.service';
import { orderByClause } from '../common/pagination';
import { EXCHANGE_COLUMNS, StoredExchange } from '../exchanges/exchange-object';
import { PAIR_KEYS, PAIR_ORDER } from '../exchanges/exchanges.service';
import { AccountGroup, ActiveAccount, attachExchanges, toActiveAccounts } from './active-account-object';

/** What the accounts of a pair are asked for; the values are already validated. */
export interface ActiveAccountsQuery {
  /** The pair as the client asked for it, in either order. */
  base: Asset;
  counter: Asset;
  /** Inclusive; both ends are whole seconds (`activeWindow`). */
  start: Date;
  endExclusive: Date;
  includeExchanges: boolean;
}

export interface ActiveAccountsResult {
  accounts: ActiveAccount[];
  /** How many exchanges the accounts were made of. */
  exchanges: number;
}

/**
 * The active accounts of a pair (`activeAccounts.js` and `hbase.getExchanges` of the original): who traded the pair in
 * a window, and how much.
 *
 * The window becomes a range of ledgers once, before the query. `exchanges` is ordered by the pair first (see
 * `ExchangesService`), with the pair in Ripple's canonical order, so the exchanges of a pair are a range of the primary
 * key and are read in order; a pair that is asked for the other way round is read as it is stored and inverted on the
 * way out. The original scanned every exchange of the window (`limit: Infinity`) and added them up in the API; here
 * ClickHouse adds them up per account and per side, and only the accounts come back. There is no page: the original
 * had none.
 */
@Injectable()
export class ActiveAccountsService {
  constructor(
    private readonly ch: ClickHouseService,
    private readonly ranges: LedgerRangeResolver,
  ) {}

  async accounts(q: ActiveAccountsQuery): Promise<ActiveAccountsResult> {
    const range = await this.ranges.resolve(q.start, q.endExclusive);
    if (!range) return { accounts: [], exchanges: 0 };

    const stored = canonicalPair(q.base, q.counter);
    const where = [
      ...PAIR_KEYS.map((k, i) => `${k.column} = {pair${i}:${k.type}}`),
      'ledger_index BETWEEN {min:UInt32} AND {max:UInt32}',
    ].join(' AND ');
    const params = {
      ...Object.fromEntries(
        [stored.base.currency, stored.base.issuer ?? '', stored.counter.currency, stored.counter.issuer ?? ''].map(
          (v, i) => [`pair${i}`, v],
        ),
      ),
      min: range.min,
      max: range.max,
    };
    // the pair is read in the order of the whole key, spelled out, and `LIMIT 1 BY` the key counts a row that was
    // written twice (the table is not collapsed before a merge, and no FINAL is used) once
    const keys = PAIR_ORDER.map((k) => k.column).join(', ');
    const exchanges = (columns: string): string =>
      `SELECT ${columns} FROM ${Table.Exchanges}
        WHERE ${where}
        ORDER BY ${orderByClause(PAIR_ORDER, false)}
        LIMIT 1 BY ${keys}`;

    // Every exchange is a row of its buyer (role 0) and one of its seller (role 1): the two sides of the accounts. One
    // pass over the exchanges, each of them twice by ARRAY JOIN, and the sums per account and role.
    const groups = await this.ch.query<AccountGroup>(
      `SELECT tupleElement(side, 1) AS account,
              tupleElement(side, 2) AS role,
              min(tuple(ledger_index, tx_index, node_index)) AS first_pos,
              ${volumeColumns()}
         FROM (${exchanges(`ledger_index, tx_index, node_index, buyer, seller, ${VOLUME_SOURCE_COLUMNS}`)})
        ARRAY JOIN [(buyer, toUInt8(0)), (seller, toUInt8(1))] AS side
        GROUP BY account, role`,
      params,
    );
    const result = toActiveAccounts(groups, stored.inverted);

    if (q.includeExchanges && result.accounts.length > 0) {
      const rows = await this.ch.query<StoredExchange>(exchanges(EXCHANGE_COLUMNS), params);
      attachExchanges(result.accounts, rows, stored.inverted);
    }
    return result;
  }
}
