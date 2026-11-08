import BigNumber from 'bignumber.js';
import { join } from 'node:path';
import { nextPassAccounts } from '../src/aggregate/tokens.job';
import { ClickHouseService } from '../src/clickhouse/clickhouse.service';
import { runMigrations } from '../src/clickhouse/migrate';
import { Table } from '../src/clickhouse/tables';
import { FixtureLedgerSource } from '../src/ingest/fixture-ledger-source';
import { LedgerWriter } from '../src/ingest/ledger-writer';
import { getNetworkProfile } from '../src/network';
import { parseContextFor } from '../src/parsers/parser.interface';
import { nextMptPassHolders, writeChangesBatch, writeMptChangesBatch } from '../src/token-history/build/changes-pass';
import { orderKeyOf } from '../src/token-history/order-key';
import { issuedSideOf, mptSideOf, TokenSide } from '../src/token-history/token-side';
import { mptIssuerOf } from '../src/util/mpt';
import { startClickHouse, StartedClickHouse } from './clickhouse-container';
import { seedTokenHistoryWorld, TokenHistoryWorld } from './tokens-world';

const CTX = parseContextFor(getNetworkProfile('xrpl'));

/** A change row as the suite reads it back. */
interface ChangeRead {
  generation: number;
  issuer: string;
  currency: string;
  ledger_index: number;
  tx_index: number;
  node_index: number;
  holder: string;
  close_time: number;
  clawback: number;
  amount_before: string;
  amount_after: string;
  counted_before: number;
  counted_after: number;
  before_known: number;
  limit: string;
  frozen: number;
  authorized: number;
  escrowed: string;
  order_exp: number;
  order_mant: string;
}

const CHANGES_SQL = `SELECT generation, issuer, currency, ledger_index, tx_index, node_index, holder, toUnixTimestamp(close_time) AS close_time,
       clawback, amount_before, amount_after, counted_before, counted_after, before_known, \`limit\`, frozen, authorized, escrowed,
       order_exp, toString(order_mant) AS order_mant
  FROM ${Table.TokenHolderChanges}
 WHERE generation = {g:UInt32}
 ORDER BY issuer, currency, ledger_index, tx_index, node_index, holder`;

interface StateRead {
  account: string;
  counterparty: string;
  currency: string;
  ledger_index: number;
  tx_index: number;
  node_index: number;
  close_time: number;
  balance: string;
  limit_peer: string;
  freeze: number;
  authorized: number;
  deleted: number;
}

/**
 * The oracle: the change log the pass should write, folded in TypeScript from `trust_line_states` with `issuedSideOf` over each
 * line's rows in key order. A line's first row in `[from, h0]` has a known before-state only when the coverage is complete and the
 * line has no row below `from`.
 */
async function foldedChanges(
  ch: ClickHouseService,
  g: number,
  from: number,
  h0: number,
  coverageComplete: boolean,
): Promise<ChangeRead[]> {
  const rows = await ch.query<StateRead>(
    `SELECT account, counterparty, currency, ledger_index, tx_index, node_index, toUnixTimestamp(close_time) AS close_time,
            balance, limit_peer, freeze, authorized, deleted
       FROM ${Table.TrustLineStates}
      ORDER BY account, counterparty, currency, ledger_index, tx_index, node_index`,
  );
  const clawbacks = new Set(
    (
      await ch.query<{ ledger_index: number; tx_index: number }>(
        `SELECT ledger_index, tx_index FROM ${Table.TxByType} WHERE tx_type IN ('Clawback', 'AMMClawback')`,
      )
    ).map((r) => `${r.ledger_index}:${r.tx_index}`),
  );
  const out: ChangeRead[] = [];
  let line = '';
  let older = false;
  let prev: TokenSide | undefined;
  for (const r of rows) {
    const key = `${r.account} ${r.counterparty} ${r.currency}`;
    if (key !== line) {
      line = key;
      older = false;
      prev = undefined;
    }
    if (r.ledger_index < from) {
      older = true;
      continue;
    }
    if (r.ledger_index > h0) continue;
    const side = issuedSideOf(r);
    if (side === null) continue;
    const before = prev ?? { counted: false, amount: '0' };
    const known = prev !== undefined || (coverageComplete && !older);
    if (before.counted || side.counted) {
      const k = orderKeyOf(side.amount, 'issued');
      out.push({
        generation: g,
        issuer: side.issuer,
        currency: side.currency,
        ledger_index: r.ledger_index,
        tx_index: r.tx_index,
        node_index: r.node_index,
        holder: side.holder,
        close_time: r.close_time,
        clawback: clawbacks.has(`${r.ledger_index}:${r.tx_index}`) ? 1 : 0,
        amount_before: before.amount,
        amount_after: side.amount,
        counted_before: before.counted ? 1 : 0,
        counted_after: side.counted ? 1 : 0,
        before_known: known ? 1 : 0,
        limit: side.limit,
        frozen: side.frozen ? 1 : 0,
        authorized: side.authorized ? 1 : 0,
        escrowed: '0',
        order_exp: k.exp,
        order_mant: k.mant.toString(),
      });
    }
    prev = side;
  }
  const order = (c: ChangeRead) => [c.issuer, c.currency, c.ledger_index, c.tx_index, c.node_index, c.holder];
  return out.sort((a, b) => {
    const [x, y] = [order(a), order(b)];
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
    return 0;
  });
}

describe('the changes pass of the token history build (e2e)', () => {
  let container: StartedClickHouse;
  let ch: ClickHouseService;
  let world: TokenHistoryWorld;
  let generation = 0;

  /** Runs the pass over every account, `batch` accounts at a time, into a new generation; returns it. */
  async function pass(from: number, h0: number, coverageComplete: boolean, batch = 3): Promise<number> {
    const g = ++generation;
    let after = '';
    for (;;) {
      const accounts = await nextPassAccounts(ch, after, batch);
      if (accounts.length === 0) return g;
      await writeChangesBatch(ch, g, accounts, from, h0, { coverageComplete });
      after = accounts[accounts.length - 1];
    }
  }

  const changesOf = (g: number) => ch.query<ChangeRead>(CHANGES_SQL, { g });

  beforeAll(async () => {
    container = await startClickHouse();
    const config = { ...container.config, database: 'token_history_changes' };
    await runMigrations({ config, log: () => undefined });
    ch = new ClickHouseService(config);
    world = await seedTokenHistoryWorld(ch, new LedgerWriter(ch, CTX));
  }, 180_000);

  afterAll(async () => {
    await ch?.close();
    await container?.container.stop();
  });

  describe('a pass over the whole world', () => {
    let g: number;
    let rows: ChangeRead[];

    beforeAll(async () => {
      g = await pass(world.first, world.head, true);
      rows = await changesOf(g);
    });

    it('writes one change per counting line change, equal to a TypeScript fold of trust_line_states', async () => {
      const want = await foldedChanges(ch, g, world.first, world.head, true);
      expect(want.length).toBeGreaterThan(40);
      expect(rows).toEqual(want);
    });

    it('writes a change for each token of a turning line', () => {
      // gate's USD of gU13 turned round at first + 2 (8 became -6): gate's token loses it, the holder's token gains it
      const turned = rows.filter((r) => r.ledger_index === world.first + 2 && r.currency === world.usd);
      const gateSide = turned.find((r) => r.issuer === world.gate && r.amount_before === '8');
      expect(gateSide).toMatchObject({ counted_before: 1, counted_after: 0, amount_after: '0' });
      const holderSide = turned.find((r) => r.holder === world.gate && r.issuer === gateSide!.holder);
      expect(holderSide).toMatchObject({ counted_before: 0, counted_after: 1, amount_before: '0', amount_after: '6' });
      expect([holderSide!.tx_index, holderSide!.node_index]).toEqual([gateSide!.tx_index, gateSide!.node_index]);
    });

    it('marks the changes of a Clawback', () => {
      const clawed = rows.filter((r) => r.clawback === 1);
      expect(clawed.map((r) => [r.holder, r.amount_before, r.amount_after]).sort()).toEqual(
        [
          [world.clawedHolder, '4', '1'],
          [world.pool, '5000', '4900'],
        ].sort(),
      );
      expect(clawed.every((r) => r.ledger_index === world.clawbackLedger && r.issuer === world.gate)).toBe(true);
      // the TrustSet of the same ledger is no clawback
      expect(rows.find((r) => r.holder === world.preexisting)?.clawback).toBe(0);
    });

    it('writes no LP currency', () => {
      expect(rows.some((r) => r.currency === world.lp)).toBe(false);
    });

    it('a batch run twice writes the same rows once', async () => {
      const count = async () =>
        Number(
          (
            await ch.queryOne<{ n: string }>(
              `SELECT toString(count()) AS n FROM ${Table.TokenHolderChanges} WHERE generation = {g:UInt32}`,
              { g },
            )
          )?.n,
        );
      const before = await count();
      expect(before).toBe(rows.length);
      const accounts = await nextPassAccounts(ch, '', 3);
      await writeChangesBatch(ch, g, accounts, world.first, world.head, { coverageComplete: true });
      expect(await count()).toBe(before);
    });
  });

  it('marks the first row of a line that predates the coverage as before_known 0', async () => {
    // complete coverage from first + 2: a line with a row below it (gU10, first changed at first + 2) starts unknown, a line made
    // at first + 4 (the pool's) starts known, and the line first seen as a ModifiedNode counts as made (the coverage is complete)
    const from = world.first + 2;
    const g = await pass(from, world.head, true);
    const rows = await changesOf(g);
    expect(rows).toEqual(await foldedChanges(ch, g, from, world.head, true));
    const firstOf = (holder: string) => rows.find((r) => r.issuer === world.gate && r.holder === holder);
    const unknown = rows.filter((r) => r.before_known === 0);
    expect(unknown.length).toBeGreaterThan(0);
    expect(unknown.every((r) => r.counted_before === 0 && r.amount_before === '0')).toBe(true);
    expect(firstOf(world.pool)?.before_known).toBe(1);
    expect(firstOf(world.preexisting)?.before_known).toBe(1);

    // incomplete coverage: no first row is known, the ModifiedNode's included
    const h = await pass(from, world.head, false);
    const incomplete = await changesOf(h);
    expect(incomplete).toEqual(await foldedChanges(ch, h, from, world.head, false));
    const firstKnown = incomplete.filter((r) => r.issuer === world.gate && r.holder === world.preexisting);
    expect(firstKnown.map((r) => r.before_known)).toEqual([0]);
    expect(incomplete.find((r) => r.issuer === world.gate && r.holder === world.pool)?.before_known).toBe(0);
  });

  it('stops at h0', async () => {
    const h0 = world.later.first;
    const g = await pass(world.first, h0, true);
    const rows = await changesOf(g);
    expect(rows.length).toBeGreaterThan(0);
    expect(Math.max(...rows.map((r) => r.ledger_index))).toBe(h0);
    expect(rows).toEqual(await foldedChanges(ch, g, world.first, h0, true));
  });
});

/** The recorded MPT ledgers of D9 (`test/fixtures/xrpl/mpt`), as the MPT state job's suite writes them. */
const MPT_LEDGERS = FixtureLedgerSource.fromDir(join(__dirname, 'fixtures/xrpl/mpt')).list();
/** An issuance of the recorded cases whose holders' tokens were made before the first recorded ledger. */
const BEFORE_FIX = '060CA3E09B41B8EB574622BE0CDA7BB12D05EB50B60C8EF5';
/** The issuance of the recorded `issuance_destroy` case: its holder's token is deleted too. */
const DESTROYED = '064E273A6D15D1F5614B4D4E3183F835BCD62E7F6FD9FFD8';

interface MptStateRead {
  holder: string;
  mpt_issuance_id: string;
  ledger_index: number;
  tx_index: number;
  node_index: number;
  close_time: number;
  tx_type: string;
  amount: string;
  escrowed_amount: string;
  flags: number;
  deleted: number;
}

/** The oracle of the MPT pass: `mptSideOf` over each holder's rows of an issuance in key order, as `foldedChanges` does for lines. */
async function foldedMptChanges(
  ch: ClickHouseService,
  g: number,
  from: number,
  h0: number,
  coverageComplete: boolean,
): Promise<ChangeRead[]> {
  const rows = await ch.query<MptStateRead>(
    `SELECT holder, mpt_issuance_id, ledger_index, tx_index, node_index, toUnixTimestamp(close_time) AS close_time, tx_type,
            toString(amount) AS amount, toString(escrowed_amount) AS escrowed_amount, flags, deleted
       FROM ${Table.MptHolderStates}
      ORDER BY holder, mpt_issuance_id, ledger_index, tx_index, node_index`,
  );
  const out: ChangeRead[] = [];
  let key = '';
  let older = false;
  let prev: TokenSide | undefined;
  for (const r of rows) {
    const k = `${r.holder} ${r.mpt_issuance_id}`;
    if (k !== key) {
      key = k;
      older = false;
      prev = undefined;
    }
    if (r.ledger_index < from) {
      older = true;
      continue;
    }
    if (r.ledger_index > h0) continue;
    const side = mptSideOf(r, mptIssuerOf(r.mpt_issuance_id));
    const before = prev ?? { counted: false, amount: '0' };
    const known = prev !== undefined || (coverageComplete && !older);
    if (before.counted || side.counted) {
      out.push({
        generation: g,
        issuer: side.issuer,
        currency: side.currency,
        ledger_index: r.ledger_index,
        tx_index: r.tx_index,
        node_index: r.node_index,
        holder: side.holder,
        close_time: r.close_time,
        clawback: r.tx_type === 'Clawback' || r.tx_type === 'AMMClawback' ? 1 : 0,
        amount_before: before.amount,
        amount_after: side.amount,
        counted_before: before.counted ? 1 : 0,
        counted_after: side.counted ? 1 : 0,
        before_known: known ? 1 : 0,
        limit: '',
        frozen: side.frozen ? 1 : 0,
        authorized: side.authorized ? 1 : 0,
        escrowed: side.escrowed,
        order_exp: 0,
        order_mant: side.amount,
      });
    }
    prev = side;
  }
  const order = (c: ChangeRead) => [c.issuer, c.currency, c.ledger_index, c.tx_index, c.node_index, c.holder];
  return out.sort((a, b) => {
    const [x, y] = [order(a), order(b)];
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
    return 0;
  });
}

describe('the MPT changes pass of the token history build (e2e)', () => {
  let container: StartedClickHouse;
  let ch: ClickHouseService;
  let first: number;
  let head: number;
  let rows: ChangeRead[];
  const G = 7;

  beforeAll(async () => {
    container = await startClickHouse();
    const config = { ...container.config, database: 'token_history_mpt_changes' };
    await runMigrations({ config, log: () => undefined });
    ch = new ClickHouseService(config);
    await new LedgerWriter(ch, CTX).write(MPT_LEDGERS);
    const ledgers = MPT_LEDGERS.map((l) => Number(l.header.ledger_index));
    first = Math.min(...ledgers);
    head = Math.max(...ledgers);
    let after = '';
    for (;;) {
      const holders = await nextMptPassHolders(ch, after, 2);
      if (holders.length === 0) break;
      await writeMptChangesBatch(ch, G, holders, first, head, { coverageComplete: true });
      after = holders[holders.length - 1];
    }
    rows = await ch.query<ChangeRead>(CHANGES_SQL, { g: G });
  }, 180_000);

  afterAll(async () => {
    await ch?.close();
    await container?.container.stop();
  });

  it('writes one change per MPToken change with amount plus escrowed', async () => {
    const want = await foldedMptChanges(ch, G, first, head, true);
    expect(want.length).toBeGreaterThan(5);
    expect(rows).toEqual(want);
    // an escrow leaves the amount where it was: the holder's balance keeps what is escrowed
    expect(rows.some((r) => r.escrowed !== '0' && r.counted_after === 1)).toBe(true);
    for (const r of rows) expect(r.issuer).toBe(mptIssuerOf(r.currency));
  });

  it('the sum of the after amounts of the newest rows equals mpt_issuances.outstanding_amount', async () => {
    // the newest row of each holder, summed per issuance
    const newest = new Map<string, ChangeRead>();
    for (const r of rows) newest.set(`${r.currency} ${r.holder}`, r);
    const supply = new Map<string, bigint>();
    for (const r of newest.values()) supply.set(r.currency, (supply.get(r.currency) ?? 0n) + BigInt(r.amount_after));
    // the outstanding amount of each issuance's newest state (what the mpt_state job writes to mpt_issuances)
    const outstanding = await ch.query<{ id: string; outstanding: string }>(
      `SELECT mpt_issuance_id AS id, toString(outstanding_amount) AS outstanding
         FROM ${Table.MptIssuanceStates}
        ORDER BY mpt_issuance_id, ledger_index DESC, tx_index DESC, node_index DESC
        LIMIT 1 BY mpt_issuance_id`,
    );
    const compared = outstanding.filter((o) => o.id !== BEFORE_FIX && supply.has(o.id));
    expect(compared.length).toBeGreaterThan(2);
    for (const o of compared) expect({ id: o.id, supply: String(supply.get(o.id)) }).toEqual({ id: o.id, supply: o.outstanding });
    expect(new BigNumber(String(supply.get(DESTROYED) ?? 0n)).isZero()).toBe(true);
  });

  it('a deleted MPToken stops counting', () => {
    const deleted = rows.filter((r) => r.currency === DESTROYED && r.counted_after === 0);
    expect(deleted.length).toBeGreaterThan(0);
    expect(deleted.every((r) => r.amount_after === '0' && r.escrowed === '0' && r.counted_before === 1)).toBe(true);
  });

  it('a batch run twice writes the same rows once', async () => {
    const holders = await nextMptPassHolders(ch, '', 2);
    await writeMptChangesBatch(ch, G, holders, first, head, { coverageComplete: true });
    const n = await ch.queryOne<{ n: string }>(
      `SELECT toString(count()) AS n FROM ${Table.TokenHolderChanges} WHERE generation = {g:UInt32}`,
      { g: G },
    );
    expect(Number(n?.n)).toBe(rows.length);
  });
});
