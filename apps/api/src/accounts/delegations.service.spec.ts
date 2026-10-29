import { NetworkProfile, Table } from '@gatehub/data-api-shared';
import { HttpException } from '@nestjs/common';
import { DELEGATION_IDS_CAP, DelegationsService, IDS_PER_READ } from './delegations.service';

/**
 * The reads of the delegations of an account against a ClickHouse stand-in that answers by the table a statement names: what is
 * asked (which tables, how many IDs at a time, in which order) is the service's, what comes back is made here. The routes and the
 * rows are the e2e suite's (`test/delegations.e2e-spec.ts`).
 */

const ACCOUNT = 'rMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q';
const idAt = (n: number): string => n.toString(16).toUpperCase().padStart(64, '0');

/** A row of `object_changes` for the delegation `n`: created in ledger `n + 1`, to `Payment`. */
const objectRow = (n: number) => ({
  object_type: 'Delegate',
  object_id: idAt(n),
  ledger_index: n + 1,
  tx_index: 0,
  tx_hash: `HASH${n}`,
  close_time: 1_700_000_000 + n,
  tx_type: 'DelegateSet',
  result: 'tesSUCCESS',
  sender: ACCOUNT,
  delegate: '',
  action: 'created',
  event: 'set',
  owner: ACCOUNT,
  counterparty: 'rBob',
  fields: JSON.stringify({
    Account: ACCOUNT,
    Authorize: 'rBob',
    Permissions: [{ Permission: { PermissionValue: 'Payment' } }],
  }),
  previous: '{}',
  event_fields: '{}',
});

function build(o: { ids: number; available?: boolean; head?: boolean }) {
  const calls: { table: string; params: Record<string, unknown> }[] = [];
  const ch = {
    query: jest.fn((sql: string, params: Record<string, unknown> = {}) => {
      if (sql.includes(`FROM ${Table.AccountObjectChanges}`)) {
        calls.push({ table: Table.AccountObjectChanges, params });
        // a read that is capped gives at most its cap
        const count = Math.min(o.ids, Number(params.cap));
        return Promise.resolve(Array.from({ length: count }, (_, n) => ({ object_id: idAt(n) })));
      }
      if (sql.includes(`FROM ${Table.ObjectChanges}`)) {
        calls.push({ table: Table.ObjectChanges, params });
        return Promise.resolve((params.ids as string[]).map((id) => objectRow(parseInt(id, 16))));
      }
      return Promise.reject(new Error(`unexpected statement: ${sql}`));
    }),
  };
  const ranges = {
    latestWithTime: jest.fn(() =>
      Promise.resolve(o.head === false ? undefined : { ledger_index: 100_000, close_time: 1_800_000_000 }),
    ),
  };
  const coverage = {
    isAvailable: jest.fn(() => o.available !== false),
    coverage: jest.fn(() => Promise.resolve({ from_ledger_index: 1, complete: true })),
  };
  const definitions = jest.fn(() => ({ TRANSACTION_TYPES: { Payment: 0 } }));
  const profile = { definitionsFallback: definitions } as unknown as NetworkProfile;
  const service = new DelegationsService(ch as never, ranges as never, coverage as never, profile);
  return { service, calls, ch, ranges, coverage, definitions };
}

const OPTIONS = { direction: 'given', limit: 200 } as const;

describe('DelegationsService', () => {
  it('reads the IDs of the direction up to the head, then the newest rows and the created rows of the IDs', async () => {
    const { service, calls } = build({ ids: 3 });
    const page = await service.page(ACCOUNT, { ...OPTIONS, direction: 'held' });
    expect(page.asOf).toEqual({ ledger_index: 100_000, close_time: 1_800_000_000 });
    expect(calls.map((c) => c.table)).toEqual([Table.AccountObjectChanges, Table.ObjectChanges, Table.ObjectChanges]);
    expect(calls[0].params).toEqual({
      account: ACCOUNT,
      type: 'Delegate',
      role: 'counterparty',
      H: 100_000,
      cap: DELEGATION_IDS_CAP + 1,
    });
    // each read of the objects names the IDs and the head
    for (const call of calls.slice(1))
      expect(call.params).toEqual({ type: 'Delegate', ids: [idAt(0), idAt(1), idAt(2)], H: 100_000 });
    // the newest first
    expect(page.rows.map((r) => r.delegation_id)).toEqual([idAt(2), idAt(1), idAt(0)]);
    expect(page.rows[0].permissions).toEqual([{ permission: 'Payment', kind: 'transaction' }]);
  });

  it('fails past DELEGATION_IDS_CAP, with the account in the message the route logs, and reads no row of the objects', async () => {
    const { service, calls } = build({ ids: DELEGATION_IDS_CAP + 1 });
    await expect(service.page(ACCOUNT, OPTIONS)).rejects.toThrow(
      `the account ${ACCOUNT} has more than ${DELEGATION_IDS_CAP} delegations given`,
    );
    // not an HttpException below 500: the route answers it with its 500 and logs it
    await expect(service.page(ACCOUNT, OPTIONS)).rejects.not.toBeInstanceOf(HttpException);
    expect(calls.map((c) => c.table)).toEqual([Table.AccountObjectChanges, Table.AccountObjectChanges]);
  });

  it('serves an account with DELEGATION_IDS_CAP IDs, a few IDs a read: each ID in one read of each kind', async () => {
    const { service, calls } = build({ ids: DELEGATION_IDS_CAP });
    const page = await service.page(ACCOUNT, { ...OPTIONS, limit: 5 });
    expect(page.rows).toHaveLength(5);
    expect(page.marker).toBeDefined();
    const reads = calls.filter((c) => c.table === Table.ObjectChanges);
    const perKind = DELEGATION_IDS_CAP / IDS_PER_READ;
    expect(reads).toHaveLength(2 * perKind);
    for (const read of reads) expect((read.params.ids as string[]).length).toBeLessThanOrEqual(IDS_PER_READ);
    const named = reads.flatMap((read) => read.params.ids as string[]);
    expect(new Set(named).size).toBe(DELEGATION_IDS_CAP);
    expect(named).toHaveLength(2 * DELEGATION_IDS_CAP);
  });

  it('answers a network without delegation with an empty page and no read of either table', async () => {
    const { service, calls, ranges } = build({ ids: 3, available: false });
    expect(await service.page(ACCOUNT, OPTIONS)).toEqual({
      asOf: { ledger_index: 100_000, close_time: 1_800_000_000 },
      rows: [],
    });
    expect(ranges.latestWithTime).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([]);
  });

  it('checks the marker before any read, on a network with delegation or not', async () => {
    for (const available of [true, false]) {
      const { service, ch, ranges } = build({ ids: 3, available });
      await expect(service.page(ACCOUNT, { ...OPTIONS, marker: '%%' })).rejects.toMatchObject({ status: 400 });
      expect(ch.query).not.toHaveBeenCalled();
      expect(ranges.latestWithTime).not.toHaveBeenCalled();
    }
  });

  it('fails with no committed ledger, whatever the rows say', async () => {
    const { service, calls } = build({ ids: 3, head: false });
    await expect(service.page(ACCOUNT, OPTIONS)).rejects.toThrow('no ledger is committed');
    expect(calls).toEqual([]);
  });

  it('reads the transaction types of the network once, for any number of pages', async () => {
    const { service, definitions } = build({ ids: 2 });
    await service.page(ACCOUNT, OPTIONS);
    await service.page(ACCOUNT, OPTIONS);
    await service.answer(ACCOUNT, { ...OPTIONS, csv: true });
    expect(definitions).toHaveBeenCalledTimes(1);
  });

  it('answers with the coverage of delegations, the point it is as of and the rows of the CSV with the names in one cell', async () => {
    const { service, coverage } = build({ ids: 2 });
    const json = await service.answer(ACCOUNT, { ...OPTIONS, csv: false });
    expect(coverage.coverage).toHaveBeenCalledWith('delegations');
    expect(Object.keys(json)).toEqual(['result', 'coverage', 'ledger_index', 'close_time', 'count', 'delegations']);
    expect([json.coverage, json.ledger_index, json.close_time, json.count]).toEqual([
      { from_ledger_index: 1, complete: true },
      100_000,
      '2027-01-15T08:00:00Z',
      2,
    ]);
    const csv = await service.answer(ACCOUNT, { ...OPTIONS, csv: true });
    expect((csv.delegations[0] as Record<string, unknown>).permissions).toBe('Payment');
  });
});
