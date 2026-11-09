import BigNumber from 'bignumber.js';
import { ClickHouseService } from '../src/clickhouse/clickhouse.service';
import { runMigrations } from '../src/clickhouse/migrate';
import { LedgersRow, TrustLineStatesRow } from '../src/clickhouse/rows';
import { Table } from '../src/clickhouse/tables';
import { committedCheckpoint } from '../src/ingest/ingest-state';
import { LedgerWriter } from '../src/ingest/ledger-writer';
import { getNetworkProfile } from '../src/network';
import { parseContextFor } from '../src/parsers/parser.interface';
import { runTokenHistoryBuild } from '../src/token-history/build/run-build';
import { TOKEN_HISTORY_CONFIG_VERSION } from '../src/token-history/constants';
import { holdersAt, totalsAt } from '../src/token-history/holders-at';
import { promoteIfCaughtUp } from '../src/token-history/promote';
import { rebuildNeeded } from '../src/token-history/rebuild-needed';
import { appendTokenHistoryDirty, markTokenHistoryDirty, repairOldestRange } from '../src/token-history/repair';
import { readTokenHistoryStates, writeTokenHistoryState } from '../src/token-history/state';
import { startClickHouse, StartedClickHouse } from './clickhouse-container';
import { SAMPLE_ROWS } from './sample-rows';
import { bruteForceLines, seedTokenHistoryWorld, TokenHistoryWorld, tokenMapKey } from './tokens-world';

const CTX = parseContextFor(getNetworkProfile('xrpl'));
const NETWORK = 'xrpl';
const SMALL = { passAccounts: 3, levelTokens: 2, floor: 5 } as const;
const REPAIR = { hasMpt: true, network: NETWORK, floor: 5 } as const;
const log = { info: () => undefined };

const dirtyRows = (ch: ClickHouseService) =>
  ch.query<{ from_ledger: number; to_ledger: number }>(
    `SELECT from_ledger, to_ledger FROM ${Table.TokenHistoryDirty} ORDER BY from_ledger, to_ledger`,
  );

describe('repair of the token history (e2e)', () => {
  let container: StartedClickHouse;
  const services: ClickHouseService[] = [];
  let dbCounter = 0;

  async function fresh(): Promise<ClickHouseService> {
    const config = { ...container.config, database: `token_history_repair_${++dbCounter}` };
    await runMigrations({ config, log: () => undefined });
    const svc = new ClickHouseService(config);
    services.push(svc);
    return svc;
  }

  /** The world, built and promoted: one live generation at the head. */
  async function liveWorld(): Promise<{ ch: ClickHouseService; world: TokenHistoryWorld }> {
    const ch = await fresh();
    const world = await seedTokenHistoryWorld(ch, new LedgerWriter(ch, CTX));
    await ch.command(
      `INSERT INTO ${Table.SyncerLease} (network, holder, heartbeat) SELECT {network:String}, 'worker-1', now64(3)`,
      { network: `${NETWORK}:token_history` },
    );
    await runTokenHistoryBuild(ch, { network: NETWORK, hasMpt: true, threads: 2, log, ...SMALL });
    expect(await promoteIfCaughtUp(ch, await readTokenHistoryStates(ch))).toBe(true);
    return { ch, world };
  }

  /** The totals of every token of generation 1 at every ledger of the world. */
  async function everyTotal(ch: ClickHouseService, world: TokenHistoryWorld): Promise<Map<string, unknown>> {
    const tokens = await ch.query<{ issuer: string; currency: string }>(
      `SELECT DISTINCT issuer, currency FROM ${Table.TokenHolderChanges} WHERE generation = 1 ORDER BY issuer, currency`,
    );
    const out = new Map<string, unknown>();
    for (const token of tokens) {
      for (const n of world.ledgers) out.set(`${tokenMapKey(token)} ${n}`, await totalsAt(ch, 1, token, n));
    }
    return out;
  }

  beforeAll(async () => {
    container = await startClickHouse();
  }, 180_000);

  afterAll(async () => {
    for (const s of services) await s.close();
    await container?.container.stop();
  });

  it('a reprocess of a range gives the same answers', async () => {
    const { ch, world } = await liveWorld();
    const before = await everyTotal(ch, world);
    await appendTokenHistoryDirty(ch, world.first + 1, world.first + 3);
    expect(await repairOldestRange(ch, await readTokenHistoryStates(ch), REPAIR)).toBe('repaired');
    expect(await dirtyRows(ch)).toEqual([]);
    expect(await everyTotal(ch, world)).toEqual(before);
    const n = await ch.queryOne<{ n: string; k: string }>(
      `SELECT toString(count()) AS n, toString(uniqExact(issuer, currency, ledger_index, tx_index, node_index, holder)) AS k
         FROM ${Table.TokenHolderChanges} WHERE generation = 1`,
    );
    expect(n?.n).toBe(n?.k);
    // nothing to do now
    expect(await repairOldestRange(ch, await readTokenHistoryStates(ch), REPAIR)).toBe('none');
  });

  it('a changed state row in the range changes exactly its tokens', async () => {
    const { ch, world } = await liveWorld();
    const before = await everyTotal(ch, world);
    // the re-ingest of first + 3 found gU10's balance at 30, not 25: both sides of the line's row are rewritten
    const at = world.first + 3;
    const rows = await ch.query<TrustLineStatesRow>(
      `SELECT * EXCEPT (close_time), toUnixTimestamp(close_time) AS close_time FROM ${Table.TrustLineStates}
        WHERE ledger_index = {at:UInt32} AND currency = 'USD' AND (balance = '25' OR balance = '-25')`,
      { at },
    );
    expect(rows).toHaveLength(2);
    await ch.command(
      `DELETE FROM ${Table.TrustLineStates} WHERE ledger_index = {at:UInt32} AND currency = 'USD' AND (balance = '25' OR balance = '-25')`,
      { at },
      { settings: { lightweight_deletes_sync: '2' } },
    );
    await ch.insert(
      Table.TrustLineStates,
      rows.map((r) => ({ ...r, balance: r.balance === '25' ? '30' : '-30' })),
    );
    await appendTokenHistoryDirty(ch, at, at);
    expect(await repairOldestRange(ch, await readTokenHistoryStates(ch), REPAIR)).toBe('repaired');

    const after = await everyTotal(ch, world);
    const usd = tokenMapKey({ issuer: world.gate, currency: world.usd });
    for (const [key, totals] of after) {
      if (key.startsWith(`${usd} `)) continue;
      expect({ key, totals }).toEqual({ key, totals: before.get(key) });
    }
    // gate's USD: 5 more from the ledger on, as the brute force says at every ledger
    for (const n of world.ledgers) {
      const lines = [...(await bruteForceLines(ch, n)).entries()].filter(([k]) => k.startsWith(`${usd} `));
      expect({ n, supply: (after.get(`${usd} ${n}`) as { supply: string }).supply }).toEqual({
        n,
        supply: lines.reduce((s, [, { line }]) => s.plus(line.balance), new BigNumber(0)).toFixed(),
      });
    }
    expect(
      new BigNumber((after.get(`${usd} ${world.head}`) as { supply: string }).supply)
        .minus((before.get(`${usd} ${world.head}`) as { supply: string }).supply)
        .toFixed(),
    ).toBe('5');
    const holder = (await holdersAt(ch, 1, { issuer: world.gate, currency: world.usd }, at)).find(
      (h) => h.amount === '30',
    );
    expect(holder?.last_ledger).toBe(at);
  });

  it('a changed state row of a line that changes again after the range leaves its later changes right', async () => {
    const { ch, world } = await liveWorld();
    const usd = tokenMapKey({ issuer: world.gate, currency: world.usd });
    // a line of gate's USD with a state row in the range and another after it: its row at `at` holds 5 more
    const holders = [...(await bruteForceLines(ch, world.head)).keys()]
      .filter((k) => k.startsWith(`${usd} `))
      .map((k) => k.slice(usd.length + 1));
    let picked: { account: string; counterparty: string } | undefined;
    for (const holder of holders) {
      const [row] = await ch.query<{ n: string; l: string }>(
        `SELECT toString(count()) AS n, toString(uniqExact(ledger_index)) AS l FROM ${Table.TrustLineStates}
          WHERE currency = {usd:String} AND account = {gate:String} AND counterparty = {holder:String}`,
        { usd: world.usd, gate: world.gate, holder },
      );
      if (Number(row.l) >= 2) {
        picked = { account: world.gate, counterparty: holder };
        break;
      }
    }
    expect(picked).toBeDefined();
    const { account, counterparty } = picked!;
    const states = await ch.query<TrustLineStatesRow>(
      `SELECT * EXCEPT (close_time), toUnixTimestamp(close_time) AS close_time FROM ${Table.TrustLineStates}
        WHERE currency = {usd:String} AND ((account = {a:String} AND counterparty = {b:String}) OR (account = {b:String} AND counterparty = {a:String}))
        ORDER BY ledger_index, tx_index, node_index`,
      { usd: world.usd, a: account, b: counterparty },
    );
    const at = states[0].ledger_index;
    expect(states.some((r) => r.ledger_index > at)).toBe(true);
    const first = states.filter((r) => r.ledger_index === at && r.tx_index === states[0].tx_index);
    await ch.command(
      `DELETE FROM ${Table.TrustLineStates}
        WHERE currency = {usd:String} AND ledger_index = {at:UInt32} AND tx_index = {tx:UInt32}
          AND ((account = {a:String} AND counterparty = {b:String}) OR (account = {b:String} AND counterparty = {a:String}))`,
      { usd: world.usd, at, tx: states[0].tx_index, a: account, b: counterparty },
      { settings: { lightweight_deletes_sync: '2' } },
    );
    const more = (balance: string) =>
      (balance.startsWith('-') ? new BigNumber(balance).minus(5) : new BigNumber(balance).plus(5)).toFixed();
    await ch.insert(
      Table.TrustLineStates,
      first.map((r) => ({ ...r, balance: more(r.balance) })),
    );
    await appendTokenHistoryDirty(ch, at, at);
    expect(await repairOldestRange(ch, await readTokenHistoryStates(ch), REPAIR)).toBe('repaired');

    // the holder's changes chain: each starts from where the one before it ended, the later one from the repaired state
    const chain = await ch.query<{ ledger_index: number; amount_before: string; amount_after: string }>(
      `SELECT ledger_index, amount_before, amount_after FROM ${Table.TokenHolderChanges}
        WHERE generation = 1 AND issuer = {gate:String} AND currency = {usd:String} AND holder = {holder:String}
        ORDER BY ledger_index, tx_index, node_index
        LIMIT 1 BY ledger_index, tx_index, node_index`,
      { gate: world.gate, usd: world.usd, holder: counterparty },
    );
    expect(chain.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < chain.length; i++) {
      expect({ ledger: chain[i].ledger_index, before: chain[i].amount_before }).toEqual({
        ledger: chain[i].ledger_index,
        before: chain[i - 1].amount_after,
      });
    }
    // every ledger's totals of gate's USD are the brute force's: the later change starts from the repaired state
    for (const n of world.ledgers) {
      const brute = (await bruteForceLines(ch, n)).entries();
      const lines = [...brute].filter(([k]) => k.startsWith(`${usd} `));
      const supply = lines.reduce((s, [, { line }]) => s.plus(line.balance), new BigNumber(0)).toFixed();
      expect({ n, supply: (await totalsAt(ch, 1, { issuer: world.gate, currency: world.usd }, n)).supply }).toEqual({
        n,
        supply,
      });
    }
  });

  it('a range below the live coverage is dropped', async () => {
    const { ch, world } = await liveWorld();
    await appendTokenHistoryDirty(ch, world.first - 100, world.first - 50);
    expect(await repairOldestRange(ch, await readTokenHistoryStates(ch), REPAIR)).toBe('dropped');
    expect(await dirtyRows(ch)).toEqual([]);
  });

  it('a range of an older parser is not repaired and sets reason repair', async () => {
    const { ch, world } = await liveWorld();
    const old: LedgersRow = {
      ...SAMPLE_ROWS[Table.Ledgers],
      ledger_index: world.first + 2,
      ledger_hash: 'OLD'.padStart(64, '0'),
      close_time: 946_684_800 + 800_000_000 + (world.first + 2) * 4,
      parser_version: 7,
    };
    await ch.insert(Table.Ledgers, [old]);
    await appendTokenHistoryDirty(ch, world.first + 2, world.first + 2);
    const head = (await committedCheckpoint(ch))!;
    expect(await rebuildNeeded(ch, await readTokenHistoryStates(ch), head)).toBe('repair');
    expect(await repairOldestRange(ch, await readTokenHistoryStates(ch), REPAIR)).toBe('older_parser');
    // the range waits for the rebuild
    expect(await dirtyRows(ch)).toEqual([{ from_ledger: world.first + 2, to_ledger: world.first + 2 }]);
  });

  describe('the reasons a build is due', () => {
    const ledger = (n: number): LedgersRow => ({
      ...SAMPLE_ROWS[Table.Ledgers],
      ledger_index: n,
      ledger_hash: String(n).padStart(64, 'E'),
      close_time: 1_700_000_000 + n * 4,
    });
    const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
    const live = (o: Partial<Parameters<typeof writeTokenHistoryState>[1]> = {}) => ({
      generation: 1,
      state: 'live' as const,
      config_version: TOKEN_HISTORY_CONFIG_VERSION,
      coverage_from: 30,
      h0: 50,
      h1: 50,
      phase: 'done' as const,
      account_cursor: '',
      token_cursor_issuer: '',
      token_cursor_currency: '',
      through_ledger: 50,
      levels_through: 50,
      started_at: 1_700_000_000,
      ...o,
    });

    it('none before the first generation, and nothing due while a build runs', async () => {
      const ch = await fresh();
      await ch.insert(Table.Ledgers, range(30, 50).map(ledger));
      expect(await rebuildNeeded(ch, [], 50)).toBe('none');
      await writeTokenHistoryState(ch, live({ state: 'building', phase: 'changes' }));
      expect(await rebuildNeeded(ch, await readTokenHistoryStates(ch), 50)).toBeUndefined();
    });

    it("filling a gap that joins the head's run sets reason coverage", async () => {
      const ch = await fresh();
      await ch.insert(Table.Ledgers, [...range(10, 20), ...range(30, 50)].map(ledger));
      await writeTokenHistoryState(ch, live());
      expect(await rebuildNeeded(ch, await readTokenHistoryStates(ch), 50)).toBeUndefined();
      await ch.insert(Table.Ledgers, range(21, 29).map(ledger));
      expect(await rebuildNeeded(ch, await readTokenHistoryStates(ch), 50)).toBe('coverage');
    });

    it('a config bump sets reason config', async () => {
      const ch = await fresh();
      await ch.insert(Table.Ledgers, range(30, 50).map(ledger));
      await writeTokenHistoryState(ch, live({ config_version: TOKEN_HISTORY_CONFIG_VERSION - 1 }));
      expect(await rebuildNeeded(ch, await readTokenHistoryStates(ch), 50)).toBe('config');
    });
  });

  it('markTokenHistoryDirty appends the ledgers closed in an hour range, and nothing for an hour without one', async () => {
    const { ch, world } = await liveWorld();
    const first = 946_684_800 + 800_000_000 + world.first * 4;
    await markTokenHistoryDirty(ch, first, first + 9);
    expect(await dirtyRows(ch)).toEqual([{ from_ledger: world.first, to_ledger: world.first + 2 }]);
    await markTokenHistoryDirty(ch, 0, 3_600);
    expect(await dirtyRows(ch)).toHaveLength(1);
  });
});
