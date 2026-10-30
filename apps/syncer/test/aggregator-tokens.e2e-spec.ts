import {
  ClickHouseService,
  FixtureLedgerSource,
  getNetworkProfile,
  LedgerWriter,
  parseContextFor,
  RatesService,
  RawLedger,
  readTokenGenerations,
  runMigrations,
  Table,
  TokenGenerationsRow,
  TOKENS_CONFIG_VERSION,
  TokensRow,
} from '@gatehub/data-api-shared';
import BigNumber from 'bignumber.js';
import { startClickHouse, StartedClickHouse } from '../../../packages/shared/test/clickhouse-container';
import {
  bruteForceTokens as bruteForceTokensOf,
  seedTokensWorld as seedWorld,
  seedTokensWorldLater as seedWorldLater,
  tokenMapKey,
  TokensWorld,
} from '../../../packages/shared/test/tokens-world';
import { AggregatorOptions, AggregatorService } from '../src/aggregator/aggregator.service';
import { rangeIngest } from '../src/cli/range-ingest';

/**
 * The `tokens` job of the `AggregatorService` against a real ClickHouse, ticked by hand: the synthetic world of
 * `packages/shared/test/tokens-world.ts` (six ledgers of trust lines and issuer settings, then four more that arrive later),
 * written by the real `LedgerWriter`. What the pass and the touches write is checked row by row in
 * `packages/shared/test/tokens-job.e2e-spec.ts`; here it is the job that is on trial, in the tick: that the first generation is
 * built and made live, that it follows the head, that a reprocessed range reaches it through `agg_dirty` and its hook (the range
 * is rewritten by the real `rangeIngest`), that a ledger of an older parser in a repair ends the repair and marks the rebuild while
 * the live touches go on, that a new config version builds, swaps and drops, and what the gauges say. The oracle is the plain
 * count of `bruteForceTokens`, from `trust_line_states`.
 */

const PROFILE = getNetworkProfile('xrpl');
const ctx = parseContextFor(PROFILE);
const NOOP = (): void => undefined;

/** The metrics of the aggregator and of the tokens job: what is set and counted is read from the mocks. */
const fakeMetrics = () => ({
  aggregatorRunsTotal: { inc: jest.fn() },
  aggregatorErrorsTotal: { inc: jest.fn() },
  aggregatorStatsLagSeconds: { set: jest.fn() },
  tokensLive: { set: jest.fn() },
  tokensLagLedgers: { set: jest.fn() },
  tokensBuilding: { set: jest.fn() },
  tokensRepairLedgers: { set: jest.fn() },
});

/** The values a gauge was set to, in order. */
const valuesOf = (gauge: { set: jest.Mock }): number[] => gauge.set.mock.calls.map(([value]) => value);

// The world is written against the sources of the shared package and this suite against its build. They declare the same classes,
// which TypeScript does not take for one (a private member each), so the world is called through these three, with the cast here.
const seedTokensWorld = (ch: ClickHouseService, writer: { write(ledgers: RawLedger[]): Promise<unknown> }) =>
  seedWorld(ch as never, writer as never);
const seedTokensWorldLater = (writer: { write(ledgers: RawLedger[]): Promise<unknown> }, world: TokensWorld) =>
  seedWorldLater(writer as never, world);
const bruteForceTokens = (ch: ClickHouseService, head: number) => bruteForceTokensOf(ch as never, head);

/** What `seedTokensWorld` writes, kept instead: the ledgers of the world as a node would serve them. */
class CapturingWriter {
  readonly ledgers: RawLedger[] = [];
  async write(ledgers: RawLedger[]): Promise<void> {
    this.ledgers.push(...ledgers);
  }
}

/**
 * The ledger with every balance of a trust line it makes or changes one more: the same lines, written another way (the reprocess of
 * a parser that reads them differently). An amount the exact sums cannot hold (the world's 1e40) is left alone.
 */
function withBalancesRaised(ledger: RawLedger): RawLedger {
  const copy = structuredClone(ledger) as RawLedger;
  for (const transaction of copy.transactions) {
    for (const node of transaction.meta.AffectedNodes as Array<Record<string, any>>) {
      const made = node.CreatedNode ?? node.ModifiedNode;
      const fields = made?.NewFields ?? made?.FinalFields;
      if (made?.LedgerEntryType !== 'RippleState' || !fields?.Balance) continue;
      const balance = new BigNumber(fields.Balance.value);
      if (balance.abs().isLessThan('1e30')) fields.Balance.value = balance.plus(1).toFixed();
    }
  }
  return copy;
}

interface Counts {
  holders: number;
  trust_lines: number;
  supply: string;
}

describe('AggregatorService tokens job (e2e)', () => {
  let container: StartedClickHouse;
  const services: ClickHouseService[] = [];
  const aggregators: AggregatorService[] = [];
  let dbCounter = 0;
  /** The ledgers of the world, as a node would serve them (`CapturingWriter`). */
  let BASE: RawLedger[];
  /** A moment after the ingest: the stats have nothing to do but jump from ledger to ledger. */
  let NOW: Date;

  beforeAll(async () => {
    container = await startClickHouse();
    const scratch = await migrated();
    const capture = new CapturingWriter();
    const world = await seedTokensWorld(scratch, capture);
    BASE = [...capture.ledgers];
    await seedTokensWorldLater(capture, world);
    NOW = new Date((Math.max(...capture.ledgers.map((l) => l.header.close_time)) + 7200) * 1000);
  });

  afterAll(async () => {
    for (const svc of aggregators) await svc.stop();
    for (const svc of services) await svc.close();
    await container?.container.stop();
  });

  /** A migrated database of its own, with nothing in it. */
  async function migrated(): Promise<ClickHouseService> {
    const config = { ...container.config, database: `aggregator_tokens_${++dbCounter}` };
    await runMigrations({ config, log: NOOP });
    const svc = new ClickHouseService(config);
    services.push(svc);
    return svc;
  }

  /** A migrated database with the world in it (its ledgers by the real `LedgerWriter`, and the domains and tomls of its issuers). */
  async function fresh(): Promise<{ ch: ClickHouseService; world: TokensWorld; writer: LedgerWriter }> {
    const ch = await migrated();
    const writer = new LedgerWriter(ch, ctx);
    const world = await seedTokensWorld(ch, writer);
    return { ch, world, writer };
  }

  /**
   * An aggregator that has the tokens job and, of the stats, only the walk from ledger to ledger (the stats have their own tests).
   * The budgets are generous: a slow machine must not make a test flaky.
   */
  function aggregator(
    ch: ClickHouseService,
    o: { tokens?: Partial<NonNullable<AggregatorOptions['tokens']>>; options?: AggregatorOptions } = {},
  ) {
    const metrics = fakeMetrics();
    const logger = { log: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() };
    const svc = new AggregatorService(ch, metrics as never, undefined, {
      logger,
      tokens: { profile: PROFILE, rates: new RatesService(ch, 'XRP'), ...o.tokens },
      recompute: async () => 0,
      tickBudgetMs: 10 * 60_000,
      budgetsMs: { tokens: 5 * 60_000 },
      ...o.options,
    });
    aggregators.push(svc);
    return { svc, metrics, logger };
  }
  type Running = ReturnType<typeof aggregator>;

  /** No job of the tick failed: nothing counted, nothing logged as an error. */
  function expectNoErrors({ metrics, logger }: Running): void {
    expect(metrics.aggregatorErrorsTotal.inc).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  }

  /** Ticks until `done` holds, at most `most` times, and says how many ticks it took. */
  async function tickUntil(running: Running, done: () => Promise<boolean>, most = 15): Promise<number> {
    let ticks = 0;
    do {
      await running.svc.tick(NOW);
      ticks++;
    } while (!(await done()) && ticks < most);
    return ticks;
  }

  const generationsOf = (ch: ClickHouseService): Promise<TokenGenerationsRow[]> => readTokenGenerations(ch);
  const generation = async (ch: ClickHouseService, n: number): Promise<TokenGenerationsRow> =>
    (await generationsOf(ch)).find((g) => g.generation === n) as TokenGenerationsRow;

  /** The newest row of each token of a generation that is not deleted, by `tokenMapKey`. */
  async function liveTokens(ch: ClickHouseService, generation: number): Promise<Map<string, TokensRow>> {
    const rows = await ch.query<TokensRow>(
      `SELECT issuer, currency, code, holders, trust_lines, supply, supply_f, last_ledger, issuer_ledger, issuer_flags,
              transfer_rate, domain, listed, name, toml, deleted
         FROM ${Table.Tokens}
        WHERE generation = {generation:UInt32}
        ORDER BY issuer, currency, version DESC
        LIMIT 1 BY issuer, currency`,
      { generation },
    );
    return new Map(rows.filter((r) => r.deleted === 0).map((r) => [tokenMapKey(r), r]));
  }

  /** The newest row of each line of a generation that is not deleted, by `issuer currency holder`. */
  async function liveLines(ch: ClickHouseService, generation: number) {
    const rows = await ch.query<{ issuer: string; currency: string; holder: string; deleted: number }>(
      `SELECT issuer, currency, holder, balance, balance_f, \`limit\`, frozen, authorized, ledger_index, deleted
         FROM ${Table.TokenLines}
        WHERE generation = {generation:UInt32}
        ORDER BY issuer, currency, holder, version DESC
        LIMIT 1 BY issuer, currency, holder`,
      { generation },
    );
    return new Map(rows.filter((r) => r.deleted === 0).map((r) => [`${r.issuer} ${r.currency} ${r.holder}`, r]));
  }

  /** The counts of the tokens of a generation, as the oracle gives them (`supply` as text, the key by `tokenMapKey`). */
  async function countsOf(ch: ClickHouseService, g: number): Promise<Map<string, Counts>> {
    return new Map(
      [...(await liveTokens(ch, g))].map(([key, t]) => [
        key,
        { holders: t.holders, trust_lines: t.trust_lines, supply: String(t.supply) },
      ]),
    );
  }

  /** The tokens of generation `g` against the plain count at `head`: the same tokens, and for each its holders, lines and supply. */
  async function expectEqualsBruteForce(ch: ClickHouseService, g: number, head: number): Promise<void> {
    const expected = await bruteForceTokens(ch, head);
    const counts = await countsOf(ch, g);
    expect([...counts.keys()].sort()).toEqual([...expected.keys()].sort());
    for (const [key, want] of expected) expect(counts.get(key)).toEqual(want);
  }

  /** The tokens of generation `g` that the plain count at `head` does not agree with. */
  async function disagreements(ch: ClickHouseService, g: number, head: number): Promise<string[]> {
    const expected = await bruteForceTokens(ch, head);
    const counts = await countsOf(ch, g);
    return [...new Set([...expected.keys(), ...counts.keys()])].filter(
      (key) => JSON.stringify(counts.get(key)) !== JSON.stringify(expected.get(key)),
    );
  }

  /** The partitions (generations) of the aggregates that have rows now, by table. */
  async function partitionsOf(ch: ClickHouseService): Promise<Record<string, string[]>> {
    const rows = await ch.query<{ table: string; partition: string }>(
      `SELECT table, partition
         FROM system.parts
        WHERE database = currentDatabase() AND table IN ({tables:Array(String)}) AND active AND rows > 0
        GROUP BY table, partition
        ORDER BY table, partition`,
      { tables: [Table.TokenLines, Table.Tokens] },
    );
    const out: Record<string, string[]> = { [Table.TokenLines]: [], [Table.Tokens]: [] };
    for (const { table, partition } of rows) out[table].push(partition);
    return out;
  }

  /** Marks the hour a ledger closed in, as the ingest of a re-run of the ledger does. */
  async function markHourOf(ch: ClickHouseService, ledger: RawLedger): Promise<void> {
    const hour = Math.floor(ledger.header.close_time / 3600) * 3600;
    await ch.command(
      `INSERT INTO ${Table.AggDirty} (from_hour, to_hour, created_at)
       SELECT toDateTime({from:UInt32}, 'UTC'), toDateTime({to:UInt32}, 'UTC'), fromUnixTimestamp64Milli({created:Int64})`,
      { from: hour, to: hour + 3600, created: Date.now() - 5000 },
    );
  }

  const dirtyRanges = async (ch: ClickHouseService): Promise<number> =>
    Number((await ch.query<{ n: string }>(`SELECT count() AS n FROM ${Table.AggDirty}`))[0].n);

  /** Rewrites the ledgers `first` .. `last` of the world with `rewrite` applied, by the real range-ingest, which marks `agg_dirty`. */
  async function reprocess(
    ch: ClickHouseService,
    first: number,
    last: number,
    rewrite: (ledger: RawLedger) => RawLedger,
  ): Promise<void> {
    const ledgers = BASE.filter((l) => l.header.ledger_index >= first && l.header.ledger_index <= last).map(rewrite);
    expect(ledgers).toHaveLength(last - first + 1);
    const result = await rangeIngest(new FixtureLedgerSource(ledgers), ch, ctx, {
      from: first,
      to: last,
      reprocess: true,
      retryBackoffMs: 1,
      quiescenceTimeoutMs: 5_000,
      maxTransientWaitMs: 0,
      logger: { log: NOOP, warn: NOOP, error: NOOP },
      metrics: {
        ammUnclassifiedTotal: { inc: NOOP },
        nftSkippedTotal: { inc: NOOP },
        objectsUnclassifiedTotal: { inc: NOOP },
        parserAnomaliesTotal: { inc: NOOP },
      } as never,
    });
    expect(result.ledgers).toBe(ledgers.length);
  }

  // -------------------------------------------------------------------------------------------------------------------

  it('builds the first generation and makes it live; every token equals the brute force at its through_ledger', async () => {
    const { ch, world } = await fresh();
    const running = aggregator(ch);
    expect(await generationsOf(ch)).toEqual([]);

    const ticks = await tickUntil(running, async () => (await generationsOf(ch))[0]?.state === 'live');
    expect(ticks).toBe(1);
    const [live, ...others] = await generationsOf(ch);
    expect(others).toEqual([]);
    expect(live).toMatchObject({
      generation: 1,
      state: 'live',
      config_version: TOKENS_CONFIG_VERSION,
      coverage_from: world.first,
      pass_done: 1,
      through_ledger: world.head,
      repair_from: 0,
    });
    expectNoErrors(running);
    expect(running.metrics.aggregatorRunsTotal.inc).toHaveBeenCalledWith({ job: 'tokens' });

    // every token of the world is there, with the counts and the supply of the plain count at the ledger the generation is through
    const expected = await bruteForceTokens(ch, live.through_ledger);
    expect(expected.size).toBeGreaterThan(8);
    await expectEqualsBruteForce(ch, 1, live.through_ledger);
    // the lines of the world are in it too, and the toml listing was matched
    expect((await liveLines(ch, 1)).size).toBeGreaterThan(30);
    const gate = (await liveTokens(ch, 1)).get(tokenMapKey({ issuer: world.gate, currency: world.usd }));
    expect(gate).toMatchObject({ code: 'USD', domain: world.gateDomain, listed: 1, name: 'Gateway Dollar' });
  });

  it('keeps the live generation current as ledgers arrive, equal to a fresh build at the same head', async () => {
    const { ch, world, writer } = await fresh();
    const incremental = aggregator(ch);
    await incremental.svc.tick(NOW);
    expect((await generation(ch, 1)).through_ledger).toBe(world.head);

    // four more ledgers: a line changed twice, one turned round and back, one emptied and one deleted, a line and a token made,
    // and the issuer's transfer rate raised twice
    const more = await seedTokensWorldLater(writer, world);
    await incremental.svc.tick(NOW);
    const moved = await generation(ch, 1);
    expect(moved).toMatchObject({ state: 'live', through_ledger: more.head, repair_from: 0 });
    expect(valuesOf(incremental.metrics.tokensLagLedgers).slice(-2)).toEqual([0, 0]);
    await expectEqualsBruteForce(ch, 1, more.head);
    expectNoErrors(incremental);

    // a second process with another config version builds a generation from the state at the same head (no touches)
    const fresher = aggregator(ch, { tokens: { configVersion: TOKENS_CONFIG_VERSION + 1 } });
    await fresher.svc.tick(NOW);
    const [first, second] = await generationsOf(ch);
    expect([first, second]).toMatchObject([
      { generation: 1, state: 'retired' },
      { generation: 2, state: 'live', config_version: TOKENS_CONFIG_VERSION + 1, through_ledger: more.head },
    ]);
    expectNoErrors(fresher);

    // row for row: the lines, and the tokens with all they say (counts, supply, settings, listing), but for the version
    const lines = await liveLines(ch, 2);
    expect(lines.size).toBeGreaterThan(30);
    expect(await liveLines(ch, 1)).toEqual(lines);
    const tokens = await liveTokens(ch, 2);
    expect(tokens.size).toBeGreaterThan(8);
    expect(await liveTokens(ch, 1)).toEqual(tokens);
    await expectEqualsBruteForce(ch, 2, more.head);
  });

  it('a reprocessed range is repaired through agg_dirty', async () => {
    const { ch, world } = await fresh();
    const running = aggregator(ch);
    await running.svc.tick(NOW);
    expect((await generation(ch, 1)).through_ledger).toBe(world.head);
    expect(await disagreements(ch, 1, world.head)).toEqual([]);

    // two ledgers are written again with other balances in their lines: the stored state is no longer what the generation says
    await reprocess(ch, world.first + 2, world.first + 3, withBalancesRaised);
    expect(await dirtyRanges(ch)).toBeGreaterThan(0);
    expect((await disagreements(ch, 1, world.head)).length).toBeGreaterThan(0);

    // the tick drains agg_dirty, and its hook asks for the repair of the ledgers of the range
    await running.svc.tick(NOW);
    expect(await dirtyRanges(ch)).toBe(0);
    const asked = await generation(ch, 1);
    expect(asked.repair_from).toBeGreaterThan(0);
    expect(asked.repair_from).toBeLessThanOrEqual(world.first + 2);
    expect(asked.through_ledger).toBe(world.head);

    // the next tick applies it, and the generation is the plain count again
    await running.svc.tick(NOW);
    expect(await generation(ch, 1)).toMatchObject({ state: 'live', through_ledger: world.head, repair_from: 0 });
    expect(await disagreements(ch, 1, world.head)).toEqual([]);
    expect(valuesOf(running.metrics.tokensRepairLedgers).at(-1)).toBe(0);
    expect(valuesOf(running.metrics.tokensLive).at(-1)).toBe(1);
    expectNoErrors(running);
    // and no other generation was started for it
    expect(await generationsOf(ch)).toHaveLength(1);
  });

  it('an older-parser ledger met in a repair window ends the repair and marks the rebuild, while the live touches go on', async () => {
    const { ch, world, writer } = await fresh();
    const running = aggregator(ch);
    await running.svc.tick(NOW);
    expect((await generation(ch, 1)).through_ledger).toBe(world.head);

    // a ledger of the world is written again by an older parser (the row of the older parser sits beside the newer one)
    await ch.command(
      `INSERT INTO ${Table.Ledgers} SELECT * REPLACE (7 AS parser_version) FROM ${Table.Ledgers} WHERE ledger_index = {ledger:UInt32}`,
      { ledger: world.first + 2 },
    );
    // its range is marked, and the tick that drains it asks for the repair
    await markHourOf(ch, BASE[0]);
    await running.svc.tick(NOW);
    expect(await dirtyRanges(ch)).toBe(0);
    expect((await generation(ch, 1)).repair_from).toBeGreaterThan(0);

    // new ledgers arrive. The repair meets the older parser's ledger and ends, with the mark of the range still in the row; the
    // touches of the new ledgers are applied all the same
    const more = await seedTokensWorldLater(writer, world);
    await running.svc.tick(NOW);
    const stuck = await generation(ch, 1);
    expect(stuck).toMatchObject({ state: 'live', through_ledger: more.head });
    expect(stuck.repair_from).toBeGreaterThan(0);
    expect(running.logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(
        /were written by a parser older than \d+; they have no touches, so the generation is replaced/,
      ),
    );
    expect(valuesOf(running.metrics.tokensRepairLedgers).at(-1)).toBeGreaterThan(0);
    await expectEqualsBruteForce(ch, 1, more.head);
    expectNoErrors(running);
    // more ledgers go on being applied while it waits for the rebuild
    expect(running.metrics.tokensLive.set).toHaveBeenLastCalledWith(1);

    // the rebuild check of a housekeeping run starts the replacement, which reads the state tables as they are, and replaces it
    await tickUntil(running, async () =>
      (await generationsOf(ch)).some((g) => g.generation === 2 && g.state === 'live'),
    );
    const [old, replacement] = await generationsOf(ch);
    expect([old, replacement]).toMatchObject([
      { generation: 1, state: 'retired' },
      { generation: 2, state: 'live', repair_from: 0, through_ledger: more.head },
    ]);
    await expectEqualsBruteForce(ch, 2, more.head);
    expect(valuesOf(running.metrics.tokensRepairLedgers).at(-1)).toBe(0);
    expectNoErrors(running);
  });

  it('a config bump builds, swaps and drops', async () => {
    const { ch, world } = await fresh();
    const first = aggregator(ch);
    await first.svc.tick(NOW);
    expect(await generation(ch, 1)).toMatchObject({ state: 'live', config_version: TOKENS_CONFIG_VERSION });
    expect(await partitionsOf(ch)).toEqual({ [Table.TokenLines]: ['1'], [Table.Tokens]: ['1'] });

    // a process with another config version: generation 2 is built from the state tables, becomes live, and generation 1 is retired
    const bumped = aggregator(ch, { tokens: { configVersion: TOKENS_CONFIG_VERSION + 1, retiredKeepMs: 0 } });
    await bumped.svc.tick(NOW);
    let [one, two] = await generationsOf(ch);
    expect([one, two]).toMatchObject([
      { generation: 1, state: 'retired' },
      {
        generation: 2,
        state: 'live',
        config_version: TOKENS_CONFIG_VERSION + 1,
        coverage_from: world.first,
        pass_done: 1,
      },
    ]);
    await expectEqualsBruteForce(ch, 2, world.head);

    // and with nothing to keep it for, the partitions of generation 1 are dropped at a tick after the one that retired it
    for (let tick = 0; tick < 5 && (await partitionsOf(ch))[Table.Tokens].includes('1'); tick++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      await bumped.svc.tick(NOW);
    }
    expect(await partitionsOf(ch)).toEqual({ [Table.TokenLines]: ['2'], [Table.Tokens]: ['2'] });
    [one, two] = await generationsOf(ch);
    expect([one.state, two.state]).toEqual(['retired', 'live']);
    expectNoErrors(bumped);
    // the generation that is live is untouched by it
    await expectEqualsBruteForce(ch, 2, world.head);
  });

  it('leaves LP lines out', async () => {
    const { ch, world } = await fresh();
    const running = aggregator(ch);
    await running.svc.tick(NOW);

    const lpRows = async (table: Table): Promise<number> =>
      Number(
        (
          await ch.query<{ n: string }>(`SELECT count() AS n FROM ${table} WHERE currency = {lp:String}`, {
            lp: world.lp,
          })
        )[0].n,
      );
    // the pool's LP line is in the state tables and in the touches, and in no token and no line of the generation
    expect(await lpRows(Table.TrustLineStates)).toBeGreaterThan(0);
    expect(await lpRows(Table.TokenLines)).toBe(0);
    expect(await lpRows(Table.Tokens)).toBe(0);

    // the ledgers that made the line are written again: the repair reads their touches, the LP line among them, and drops it
    await reprocess(ch, world.first + 4, world.first + 5, withBalancesRaised);
    expect(await lpRows(Table.StateTouches)).toBeGreaterThan(0);
    await running.svc.tick(NOW);
    await running.svc.tick(NOW);
    expect(await generation(ch, 1)).toMatchObject({ state: 'live', repair_from: 0, through_ledger: world.head });
    expect(await lpRows(Table.TokenLines)).toBe(0);
    expect(await lpRows(Table.Tokens)).toBe(0);
    expect([...(await liveTokens(ch, 1)).values()].filter((t) => t.currency === world.lp)).toEqual([]);
    expect(await disagreements(ch, 1, world.head)).toEqual([]);
    expectNoErrors(running);
  });

  it('syncer_tokens_live is 1 and the lag 0 once caught up', async () => {
    const ch = await migrated();
    // no ledger yet: nothing to build a generation from, and the gauges say so
    const empty = aggregator(ch);
    await empty.svc.tick(NOW);
    expect(await generationsOf(ch)).toEqual([]);
    expect(valuesOf(empty.metrics.tokensLive)).toEqual([0]);
    expect(valuesOf(empty.metrics.tokensLagLedgers)).toEqual([0]);
    expect(valuesOf(empty.metrics.tokensBuilding)).toEqual([0]);
    expect(valuesOf(empty.metrics.tokensRepairLedgers)).toEqual([0]);
    expectNoErrors(empty);

    // the ledgers arrive: the generation is built and live, and the lag is 0
    const writer = new LedgerWriter(ch, ctx);
    const world = await seedTokensWorld(ch, writer);
    await tickUntil(empty, async () => valuesOf(empty.metrics.tokensLive).at(-1) === 1);
    expect(valuesOf(empty.metrics.tokensLive).at(-1)).toBe(1);
    expect(valuesOf(empty.metrics.tokensLagLedgers).at(-1)).toBe(0);
    expect(valuesOf(empty.metrics.tokensBuilding).at(-1)).toBe(0);
    expect(valuesOf(empty.metrics.tokensRepairLedgers).at(-1)).toBe(0);

    // the head moves on and a run that cannot apply the touches (no budget) says how far behind the generation is
    const more = await seedTokensWorldLater(writer, world);
    const stalled = aggregator(ch, { options: { budgetsMs: { tokens: 0 } } });
    await stalled.svc.tick(NOW);
    expect(valuesOf(stalled.metrics.tokensLive)).toEqual([1]);
    expect(valuesOf(stalled.metrics.tokensLagLedgers)).toEqual([more.head - world.head]);
    expect((await generation(ch, 1)).through_ledger).toBe(world.head);

    // and a run with a budget catches up, and says 0 again
    await empty.svc.tick(NOW);
    expect(valuesOf(empty.metrics.tokensLive).at(-1)).toBe(1);
    expect(valuesOf(empty.metrics.tokensLagLedgers).at(-1)).toBe(0);
    expect((await generation(ch, 1)).through_ledger).toBe(more.head);
    expectNoErrors(empty);
    expectNoErrors(stalled);
  });
});
