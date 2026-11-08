import { ClickHouseService } from '../src/clickhouse/clickhouse.service';
import { runMigrations } from '../src/clickhouse/migrate';
import { LedgersRow, MptHolderStatesRow, TokenHistoryStateRow } from '../src/clickhouse/rows';
import { Table } from '../src/clickhouse/tables';
import { committedCheckpoint } from '../src/ingest/ingest-state';
import { LedgerWriter } from '../src/ingest/ledger-writer';
import { getNetworkProfile } from '../src/network';
import { parseContextFor } from '../src/parsers/parser.interface';
import { runTokenHistoryBuild } from '../src/token-history/build/run-build';
import { holdersAt, totalsAt } from '../src/token-history/holders-at';
import { applyLiveWindow, OlderParserWindow } from '../src/token-history/live-window';
import { readTokenHistoryStates, writeTokenHistoryState } from '../src/token-history/state';
import { mptIssuanceId } from '../src/util/mpt';
import { startClickHouse, StartedClickHouse } from './clickhouse-container';
import { SAMPLE_ROWS } from './sample-rows';
import { seedTokenHistoryWorldLater, seedTokensWorld, TokenHistoryWorld, TokensWorld } from './tokens-world';

const CTX = parseContextFor(getNetworkProfile('xrpl'));
const NETWORK = 'xrpl';
const MPT = mptIssuanceId(7, 'rBEERdzDHqDyYmfw2jqzyMNBZu31yzfg6q');
const SMALL = { passAccounts: 3, levelTokens: 2, floor: 5 } as const;
/** The ripple epoch, 2000-01-01, in unix seconds. */
const RIPPLE_EPOCH = 946_684_800;
const LIVE = { hasMpt: true, network: NETWORK, floor: 5 } as const;

/** Three MPT holders whose tokens change in the world's ledgers, the first batch's and the later ones, with their touches. */
async function seedMpt(ch: ClickHouseService, first: number): Promise<void> {
  const state = (holder: string, ledger: number, amount: string, deleted = 0): MptHolderStatesRow => ({
    holder,
    mpt_issuance_id: MPT,
    ledger_index: ledger,
    tx_index: 50,
    node_index: 0,
    tx_hash: `mpt-${holder}-${ledger}`,
    tx_type: ledger === first + 8 ? 'Clawback' : 'Payment',
    // the world's close times: 800,000,000 + 4 a ledger in the ripple epoch, stored as unix seconds
    close_time: RIPPLE_EPOCH + 800_000_000 + ledger * 4,
    amount,
    escrowed_amount: '0',
    flags: 0,
    deleted,
  });
  const rows = [
    state('rMptA000000000000000000000000000000', first, '0'),
    state('rMptA000000000000000000000000000000', first + 2, '100'),
    state('rMptB000000000000000000000000000000', first + 1, '0'),
    state('rMptB000000000000000000000000000000', first + 7, '40'),
    state('rMptA000000000000000000000000000000', first + 8, '60'),
    state('rMptC000000000000000000000000000000', first + 9, '0', 1),
  ];
  await ch.insert(Table.MptHolderStates, rows);
  await ch.insert(
    Table.MptTouches,
    rows.map((r) => ({ ledger_index: r.ledger_index, tx_index: r.tx_index, mpt_issuance_id: r.mpt_issuance_id, holder: r.holder })),
  );
}

async function freshWorkerLease(ch: ClickHouseService): Promise<void> {
  await ch.command(
    `INSERT INTO ${Table.SyncerLease} (network, holder, heartbeat) SELECT {network:String}, 'worker-1', now64(3)`,
    { network: `${NETWORK}:token_history` },
  );
}

/** The generations a window writes: the live one and a building one. */
const writable = async (ch: ClickHouseService): Promise<TokenHistoryStateRow[]> =>
  (await readTokenHistoryStates(ch)).filter((g) => g.state !== 'retired');

/** Applies live windows until every generation is at the head. */
async function followTheHead(ch: ClickHouseService, o: { window?: number } = {}): Promise<number> {
  const head = (await committedCheckpoint(ch))!;
  let windows = 0;
  for (;;) {
    const gens = await writable(ch);
    if (gens.every((g) => g.through_ledger >= head)) return windows;
    await applyLiveWindow(ch, gens, head, { ...LIVE, ...o });
    windows++;
  }
}

/** Every table of a generation, deduplicated, without versions; `final` is left out of the hour rows (see the ruling of Task 16). */
const TABLES = `SELECT t, r FROM (
  SELECT 'changes' AS t, toString(tuple(issuer, currency, ledger_index, tx_index, node_index, holder, toUnixTimestamp(close_time),
         clawback, amount_before, amount_after, counted_before, counted_after, before_known, \`limit\`, frozen, authorized, escrowed,
         order_exp, order_mant)) AS r
    FROM ${Table.TokenHolderChanges} WHERE generation = {g:UInt32} GROUP BY r
  UNION ALL
  SELECT 'checkpoints', toString(tuple(issuer, currency, checkpoint_ledger, holder, amount, escrowed, \`limit\`, frozen, authorized,
         order_exp, order_mant, first_ledger, last_ledger))
    FROM ${Table.TokenCheckpoints} WHERE generation = {g:UInt32} GROUP BY 2
  UNION ALL
  SELECT 'heads', toString(tuple(issuer, currency, checkpoint_ledger, supply, holders, trust_lines, changes_since, first_ledger))
    FROM ${Table.TokenCheckpointHeads} WHERE generation = {g:UInt32} GROUP BY 2
  UNION ALL
  SELECT 'hours', toString(tuple(issuer, currency, hour, supply, holders, trust_lines, issued, redeemed, clawed_back, transferred,
         transfers, changes, unknown_before, first_ledger, last_ledger))
    FROM (SELECT * FROM ${Table.TokenHourly} WHERE generation = {g:UInt32}
          ORDER BY issuer, currency, hour, version DESC LIMIT 1 BY issuer, currency, hour)
   GROUP BY 2)
 ORDER BY t, r`;

describe('live windows of the token history (e2e)', () => {
  let container: StartedClickHouse;
  const services: ClickHouseService[] = [];
  let dbCounter = 0;
  const log = { info: () => undefined };

  async function fresh(): Promise<ClickHouseService> {
    const config = { ...container.config, database: `token_history_live_${++dbCounter}` };
    await runMigrations({ config, log: () => undefined });
    const svc = new ClickHouseService(config);
    services.push(svc);
    return svc;
  }

  /** A database at the first batch's head, with its generation built there (`h0 = h1 =` that head) and a worker lease. */
  async function builtAtFirstBatch(): Promise<{ ch: ClickHouseService; writer: LedgerWriter; world: TokensWorld }> {
    const ch = await fresh();
    const writer = new LedgerWriter(ch, CTX);
    const world = await seedTokensWorld(ch, writer);
    await seedMpt(ch, world.first);
    await freshWorkerLease(ch);
    expect(await runTokenHistoryBuild(ch, { network: NETWORK, hasMpt: true, threads: 2, log, ...SMALL })).toEqual({
      generation: 1,
      phase: 'done',
    });
    return { ch, writer, world };
  }

  beforeAll(async () => {
    container = await startClickHouse();
  }, 180_000);

  afterAll(async () => {
    for (const s of services) await s.close();
    await container?.container.stop();
  });

  describe('build equals live', () => {
    let built: ClickHouseService;
    let live: ClickHouseService;
    let world: TokenHistoryWorld;

    beforeAll(async () => {
      // A: the whole world written, then built
      built = await fresh();
      const writer = new LedgerWriter(built, CTX);
      world = await seedTokenHistoryWorldLater(writer, await seedTokensWorld(built, writer));
      await seedMpt(built, world.first);
      await freshWorkerLease(built);
      await runTokenHistoryBuild(built, { network: NETWORK, hasMpt: true, threads: 2, log, ...SMALL });
      // B: built at the first batch's head, then the rest of the world, followed by live windows of one ledger
      const b = await builtAtFirstBatch();
      live = b.ch;
      await seedTokenHistoryWorldLater(b.writer, b.world);
      expect(await followTheHead(live, { window: 1 })).toBeGreaterThan(3);
    }, 240_000);

    it('build equals live', async () => {
      const [a] = await readTokenHistoryStates(built);
      const [b] = await readTokenHistoryStates(live);
      expect(a.through_ledger).toBe(world.head);
      expect({ through: b.through_ledger, levels: b.levels_through }).toEqual({ through: world.head, levels: world.head });
      const rows = await live.query<{ t: string; r: string }>(TABLES, { g: 1 });
      expect(new Set(rows.map((r) => r.t))).toEqual(new Set(['changes', 'checkpoints', 'heads', 'hours']));
      expect(rows).toEqual(await built.query(TABLES, { g: 1 }));
    });

    it('the holders and totals of every ledger agree', async () => {
      const tokens = await built.query<{ issuer: string; currency: string }>(
        `SELECT DISTINCT issuer, currency FROM ${Table.TokenHolderChanges} WHERE generation = 1`,
      );
      const sort = (a: { holder: string }, b: { holder: string }) => (a.holder < b.holder ? -1 : 1);
      for (const token of tokens) {
        for (let n = world.first; n <= world.head; n++) {
          expect((await holdersAt(live, 1, token, n)).sort(sort)).toEqual((await holdersAt(built, 1, token, n)).sort(sort));
          expect(await totalsAt(live, 1, token, n)).toEqual(await totalsAt(built, 1, token, n));
        }
      }
    });

    it('a final hour row of the live windows is final in the build too', async () => {
      const finals = async (ch: ClickHouseService) =>
        new Map(
          (
            await ch.query<{ k: string; final: number }>(
              `SELECT concat(issuer, ' ', currency, ' ', toString(hour)) AS k, final FROM ${Table.TokenHourly}
                WHERE generation = 1 ORDER BY issuer, currency, hour, version DESC LIMIT 1 BY issuer, currency, hour`,
            )
          ).map((r) => [r.k, r.final]),
        );
      const a = await finals(built);
      for (const [k, final] of await finals(live)) if (final === 1) expect({ k, final: a.get(k) }).toEqual({ k, final: 1 });
    });
  });

  it('a window applied twice changes nothing', async () => {
    const { ch, writer, world } = await builtAtFirstBatch();
    await seedTokenHistoryWorldLater(writer, world);
    const head = (await committedCheckpoint(ch))!;
    const gens = await writable(ch);
    await applyLiveWindow(ch, gens, head, { ...LIVE, window: 2 });
    const once = await ch.query(TABLES, { g: 1 });
    const [after] = await readTokenHistoryStates(ch);
    await applyLiveWindow(ch, gens, head, { ...LIVE, window: 2 });
    expect(await ch.query(TABLES, { g: 1 })).toEqual(once);
    const [again] = await readTokenHistoryStates(ch);
    expect({ through: again.through_ledger, levels: again.levels_through }).toEqual({
      through: after.through_ledger,
      levels: after.levels_through,
    });
    const n = await ch.queryOne<{ n: string; k: string }>(
      `SELECT toString(count()) AS n, toString(uniqExact(issuer, currency, ledger_index, tx_index, node_index, holder)) AS k
         FROM ${Table.TokenHolderChanges} WHERE generation = 1`,
    );
    expect(n?.n).toBe(n?.k);
  });

  it('a crash before the state row is invisible and redone', async () => {
    const { ch, writer, world } = await builtAtFirstBatch();
    await seedTokenHistoryWorldLater(writer, world);
    const head = (await committedCheckpoint(ch))!;
    const gens = await writable(ch);
    const [before] = gens;
    const usd = { issuer: world.gate, currency: world.usd };
    const totals = await totalsAt(ch, 1, usd, before.levels_through);
    await expect(
      applyLiveWindow(ch, gens, head, {
        ...LIVE,
        window: 3,
        afterStep: (step) => {
          if (step === 'hours') throw new Error('crashed after the hour sets');
        },
      }),
    ).rejects.toThrow('crashed after the hour sets');
    // the state is as it was, and a reader capped at levels_through sees what it saw
    const [crashed] = await readTokenHistoryStates(ch);
    expect({ through: crashed.through_ledger, levels: crashed.levels_through }).toEqual({
      through: before.through_ledger,
      levels: before.levels_through,
    });
    expect(await totalsAt(ch, 1, usd, crashed.levels_through)).toEqual(totals);
    // applied again, the window gives the state of one that never crashed
    await applyLiveWindow(ch, gens, head, { ...LIVE, window: 3 });
    const other = await builtAtFirstBatch();
    await seedTokenHistoryWorldLater(other.writer, other.world);
    await applyLiveWindow(other.ch, await writable(other.ch), head, { ...LIVE, window: 3 });
    expect(await ch.query(TABLES, { g: 1 })).toEqual(await other.ch.query(TABLES, { g: 1 }));
  });

  it('a building generation in changes gets change rows only', async () => {
    const { ch, writer, world } = await builtAtFirstBatch();
    // a second generation, its build in its changes pass at the first batch's head
    const [g1] = await readTokenHistoryStates(ch);
    await writeTokenHistoryState(ch, {
      ...g1,
      generation: 2,
      state: 'building',
      phase: 'changes',
      h1: 0,
      through_ledger: g1.h0,
      levels_through: g1.h0,
      account_cursor: '',
      token_cursor_issuer: '',
      token_cursor_currency: '',
    });
    await seedTokenHistoryWorldLater(writer, world);
    await followTheHead(ch, { window: 5 });
    const [one, two] = await readTokenHistoryStates(ch);
    expect(two).toMatchObject({ through_ledger: one.through_ledger, levels_through: g1.h0, phase: 'changes' });
    const counts = await ch.queryOne<{ changes: string; hours: string; heads: string; low: string }>(
      `SELECT (SELECT toString(count()) FROM ${Table.TokenHolderChanges} WHERE generation = 2) AS changes,
              (SELECT toString(count()) FROM ${Table.TokenHourly} WHERE generation = 2) AS hours,
              (SELECT toString(count()) FROM ${Table.TokenCheckpointHeads} WHERE generation = 2) AS heads,
              (SELECT toString(min(ledger_index)) FROM ${Table.TokenHolderChanges} WHERE generation = 2) AS low`,
    );
    expect(Number(counts?.changes)).toBeGreaterThan(5);
    expect({ hours: counts?.hours, heads: counts?.heads }).toEqual({ hours: '0', heads: '0' });
    // the changes above h0: the build's pass writes the ones up to it
    expect(Number(counts?.low)).toBeGreaterThan(g1.h0);
  });

  it('a window of an older parser is refused', async () => {
    const { ch, world } = await builtAtFirstBatch();
    const old: LedgersRow = {
      ...SAMPLE_ROWS[Table.Ledgers],
      ledger_index: world.head + 1,
      ledger_hash: String(world.head + 1).padStart(64, 'D'),
      close_time: RIPPLE_EPOCH + 800_000_000 + (world.head + 1) * 4,
      parser_version: 7,
    };
    await ch.insert(Table.Ledgers, [old]);
    const gens = await writable(ch);
    const window = applyLiveWindow(ch, gens, world.head + 1, LIVE);
    await expect(window).rejects.toBeInstanceOf(OlderParserWindow);
    await expect(window).rejects.toThrow(`${world.head}`);
    const [state] = await readTokenHistoryStates(ch);
    expect(state.through_ledger).toBe(world.head);
  });
});
