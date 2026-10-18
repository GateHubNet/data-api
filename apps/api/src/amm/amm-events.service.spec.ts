import { ClickHouseService, Table } from '@gatehub/data-api-shared';
import { notFound } from '../common/errors';
import { LedgerRangeResolver } from '../common/ledger-range.service';
import { ExchangesService } from '../exchanges/exchanges.service';
import { AmmEventsService } from './amm-events.service';
import { AmmPoolsService } from './amm-pools.service';

/**
 * The event lists of a pool against stand-ins: which checks come before which read, and what the read is asked for. The rows
 * and the plans are the e2e suite's (`amm-events.e2e-spec.ts`).
 */

const POOL = 'rHUpaqUPbwzKZdzQ8ZQCme18FrgW9pB4am';
const PAIR = { base: { currency: 'XRP' }, counter: { currency: 'USD', issuer: 'rMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q' } };
const NOT_FOUND = { response: { message: 'pool not found' } };

function build(options: { pool?: 'found' | 'unknown'; range?: { min: number; max: number } | null } = {}) {
  const order: string[] = [];
  const ch = {
    query: jest.fn((sql: string) => {
      order.push(sql.includes('distinct_page_cap') ? 'page' : 'query');
      return Promise.resolve([]);
    }),
  };
  const ranges = {
    resolve: jest.fn(() => {
      order.push('range');
      return Promise.resolve(options.range === undefined ? { min: 1, max: 99 } : options.range);
    }),
  };
  const pools = {
    requirePool: jest.fn(() => {
      order.push('pool');
      if (options.pool === 'unknown') return Promise.reject(notFound('pool not found'));
      return Promise.resolve(PAIR);
    }),
  };
  const exchanges = { pair: jest.fn(() => Promise.resolve({ exchanges: [] })) };
  const service = new AmmEventsService(
    ch as unknown as ClickHouseService,
    ranges as unknown as LedgerRangeResolver,
    pools as unknown as AmmPoolsService,
    exchanges as unknown as ExchangesService,
  );
  return { service, ch, ranges, pools, exchanges, order };
}

const window = { pool: POOL, descending: false, limit: 5 };

describe('AmmEventsService.liquidity and governance', () => {
  it('check the marker before any read, then the pool, then the range, then read the page', async () => {
    const { service, order } = build();
    await service.liquidity(window);
    expect(order).toEqual(['pool', 'range', 'page']);

    const bad = build();
    await expect(bad.service.liquidity({ ...window, marker: '!' })).rejects.toMatchObject({
      response: { message: 'invalid marker' },
    });
    await expect(bad.service.governance({ ...window, marker: '!' })).rejects.toMatchObject({
      response: { message: 'invalid marker' },
    });
    expect(bad.order).toEqual([]);
  });

  it('are 404 for a pool with no state, without reading the events', async () => {
    const { service, ch, ranges } = build({ pool: 'unknown' });
    for (const call of [() => service.liquidity(window), () => service.governance(window)]) {
      await expect(call()).rejects.toMatchObject(NOT_FOUND);
    }
    expect(ch.query).not.toHaveBeenCalled();
    expect(ranges.resolve).not.toHaveBeenCalled();
  });

  it('answer an empty page, without a read, when no ledger lies in the window', async () => {
    const { service, ch } = build({ range: null });
    expect(await service.liquidity(window)).toEqual({ events: [] });
    expect(await service.governance(window)).toEqual({ items: [] });
    expect(ch.query).not.toHaveBeenCalled();
  });

  it('read the pool by its key in the range of ledgers, with the filters in the capped read and one row more than the page', async () => {
    const { service, ch } = build();
    await service.liquidity({ ...window, event: 'deposit', account: 'rLP' });
    const [sql, params] = ch.query.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(sql).toContain(`FROM ${Table.AmmLiquidity}`);
    expect(sql).toContain('amm_account = {pool:String}');
    expect(sql).toContain('ledger_index BETWEEN {min:UInt32} AND {max:UInt32}');
    expect(sql).toContain('event = {event:String}');
    expect(sql).toContain('account = {account:String}');
    expect(sql).toMatch(
      /ORDER BY amm_account ASC, ledger_index ASC, tx_index ASC\s+LIMIT \{distinct_page_cap:UInt32\}/,
    );
    expect(params).toMatchObject({
      pool: POOL,
      min: 1,
      max: 99,
      event: 'deposit',
      account: 'rLP',
      distinct_page_limit: 6,
    });

    await service.governance({ ...window, type: 'bid', descending: true });
    const [gov, govParams] = ch.query.mock.calls[1] as unknown as [string, Record<string, unknown>];
    expect(gov).toContain(`FROM ${Table.AmmGovernance}`);
    expect(gov).toContain('kind = {kind:String}');
    expect(gov).toMatch(/ORDER BY amm_account DESC, ledger_index DESC, tx_index DESC/);
    expect(govParams).toMatchObject({ kind: 'bid' });
  });

  it('read without a filter that was not asked for', async () => {
    const { service, ch } = build();
    await service.liquidity(window);
    const [sql, params] = ch.query.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(sql).not.toContain('event = {event:String}');
    expect(sql).not.toContain('account = {account:String}');
    expect(params).not.toHaveProperty('event');
    await service.governance(window);
    expect((ch.query.mock.calls[1] as unknown as [string])[0]).not.toContain('kind = ');
  });
});

describe('AmmEventsService.swaps', () => {
  const swaps = { ...window, start: new Date('2013-01-01'), autobridged: false, amm: 'exclude' as const, limit: 7 };

  it('is the pair read of the pool: the pair its states name, only swaps, the pool account', async () => {
    const { service, exchanges } = build();
    await service.swaps(swaps);
    expect(exchanges.pair).toHaveBeenCalledTimes(1);
    expect(exchanges.pair).toHaveBeenCalledWith(
      expect.objectContaining({
        base: PAIR.base,
        counter: PAIR.counter,
        amm: 'only',
        ammAccount: POOL,
        limit: 7,
        start: swaps.start,
        autobridged: false,
        descending: false,
      }),
    );
    // the pool is the account of the read, not a key of the window it hands on
    expect((exchanges.pair.mock.calls as unknown as [Record<string, unknown>][])[0][0]).not.toHaveProperty('pool');
  });

  it('checks the marker, then the pool, before reading', async () => {
    const bad = build();
    await expect(bad.service.swaps({ ...swaps, marker: '!' })).rejects.toMatchObject({
      response: { message: 'invalid marker' },
    });
    expect(bad.pools.requirePool).not.toHaveBeenCalled();
    const unknown = build({ pool: 'unknown' });
    await expect(unknown.service.swaps(swaps)).rejects.toMatchObject(NOT_FOUND);
    expect(unknown.exchanges.pair).not.toHaveBeenCalled();
  });
});
