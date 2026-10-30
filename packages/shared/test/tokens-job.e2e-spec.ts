import { TokenKey } from '../src/aggregate/token-rules';
import {
  applyLineStates,
  buildingGenerationOf,
  distinctHolders,
  dropTokenGeneration,
  ISSUER_TOKENS_SQL,
  issuerDomains,
  LINE_STATES_SQL,
  LineKey,
  liveGenerationOf,
  nextPassAccounts,
  PARSER_FLOOR_SQL,
  parserFloorOf,
  PASS_LINES_SELECT,
  passTokens,
  readTokenGenerations,
  recomputeTokens,
  stateCoverageStart,
  STORED_LINES_SQL,
  TOKENS_PASS_ACCOUNTS,
  TOKENS_STATE_CHUNK,
  TOKENS_TOML_DOMAINS_CHUNK,
  TokensAborted,
  tokensOfIssuers,
  tokensVersionFloor,
  tomlSweep,
  touchesOfWindow,
  WINDOW_ISSUERS_SQL,
  WINDOW_LINES_SQL,
  writePassLines,
  writeTokenGeneration,
} from '../src/aggregate/tokens.job';
import { ClickHouseService } from '../src/clickhouse/clickhouse.service';
import { runMigrations } from '../src/clickhouse/migrate';
import {
  AccountStatesRow,
  DomainTomlsRow,
  PARSER_VERSION,
  TokenGenerationsRow,
  TokenLinesRow,
  TokensRow,
} from '../src/clickhouse/rows';
import { Table } from '../src/clickhouse/tables';
import { LedgerWriter } from '../src/ingest/ledger-writer';
import { getNetworkProfile } from '../src/network';
import { parseContextFor } from '../src/parsers/parser.interface';
import { TomlCurrency } from '../src/tomls/toml-read';
import { okTomlRow, tomlUrlOf } from '../src/tomls/toml-store';
import { startClickHouse, StartedClickHouse } from './clickhouse-container';
import { SAMPLE_ROWS } from './sample-rows';
import {
  bruteForceLines,
  bruteForceTokens,
  lineMapKey,
  seedTokensWorld,
  seedTokensWorldLater,
  tokenMapKey,
  TokensWorld,
} from './tokens-world';

/**
 * The shared part of the tokens job on a real ClickHouse (spec 3.1, 3.7): the generations, the account pass that builds `token_lines`
 * from `trust_line_states`, and the `tokens` rows. The world (`tokens-world.ts`) is written through the real `LedgerWriter` once; the
 * tests build generations of it and compare them with the brute force, which counts the same lines the plain way in TypeScript.
 */

const PROFILE = getNetworkProfile('xrpl');
const CTX = parseContextFor(PROFILE);

describe('the tokens job (e2e)', () => {
  let container: StartedClickHouse;
  const services: ClickHouseService[] = [];
  let dbCounter = 0;
  let ch: ClickHouseService;
  let world: TokensWorld;
  let clock = 1_800_000_000_000;

  /** A version above every one before it. */
  const nextVersion = (): string => String(++clock);

  /** A migrated database of its own. */
  async function fresh(): Promise<ClickHouseService> {
    const config = { ...container.config, database: `tokens_job_${++dbCounter}` };
    await runMigrations({ config, log: () => undefined });
    const svc = new ClickHouseService(config);
    services.push(svc);
    return svc;
  }

  /**
   * Builds `generation` from the state at `head` as the runner does, `batch` accounts at a time: the pass of each batch, then the
   * tokens of its issuers. Returns the number of batches.
   */
  async function buildGeneration(
    svc: ClickHouseService,
    generation: number,
    head: number,
    batch = 3,
    accounts = nextPassAccounts,
  ): Promise<number> {
    let after = '';
    let batches = 0;
    for (;;) {
      const next = await accounts(svc, after, batch);
      if (next.length === 0) return batches;
      const through = next[next.length - 1];
      const version = nextVersion();
      await writePassLines(svc, { generation, after, through, head, version });
      const tokens = await passTokens(svc, { generation, after, through });
      await recomputeTokens(svc, { generation, tokens, atLedger: head, version, profile: PROFILE, rematch: 'all' });
      after = through;
      batches++;
    }
  }

  /** The newest row of each token of a generation that is not deleted, by `tokenMapKey`. */
  async function liveTokens(svc: ClickHouseService, generation: number): Promise<Map<string, TokensRow>> {
    const rows = await svc.query<Omit<TokensRow, 'version'> & { version_text: string }>(
      `SELECT issuer, currency, code, holders, trust_lines, supply, supply_f, last_ledger, issuer_ledger, issuer_flags,
              transfer_rate, domain, listed, name, toml, deleted, toString(version) AS version_text
         FROM ${Table.Tokens}
        WHERE generation = {generation:UInt32}
        ORDER BY issuer, currency, version DESC
        LIMIT 1 BY issuer, currency`,
      { generation },
    );
    // the alias is not `version`: it would shadow the column and `ORDER BY version` would sort the text
    return new Map(
      rows
        .filter((r) => r.deleted === 0)
        .map(({ version_text, ...row }): [string, TokensRow] => [tokenMapKey(row), { ...row, version: version_text }]),
    );
  }

  /** The newest row of each line of a generation that is not deleted, by `lineMapKey`. */
  async function liveLines(svc: ClickHouseService, generation: number): Promise<Map<string, TokenLinesRow>> {
    const rows = await svc.query<TokenLinesRow>(
      `SELECT issuer, currency, holder, balance, balance_f, \`limit\`, frozen, authorized, ledger_index, deleted
         FROM ${Table.TokenLines}
        WHERE generation = {generation:UInt32}
        ORDER BY issuer, currency, holder, version DESC
        LIMIT 1 BY issuer, currency, holder`,
      { generation },
    );
    return new Map(rows.filter((r) => r.deleted === 0).map((r) => [lineMapKey(r, r.holder), r]));
  }

  const tokenOf = (issuer: string, currency: string): string => tokenMapKey({ issuer, currency });

  const hexOf = (text: string): string => Buffer.from(text).toString('hex').toUpperCase();

  /** The stored toml of a domain that lists one currency (`currency` as the toml writes its code) of an issuer. */
  const tomlRow = (domain: string, issuer: string, currency: string, name: string, checked: number): DomainTomlsRow =>
    okTomlRow({
      domain,
      tomlUrl: tomlUrlOf(domain, PROFILE),
      content: {
        modified: null,
        expires: null,
        accounts: [],
        currencies: [{ code: currency, issuer, network: '', fields: JSON.stringify({ name }) }],
        validators: [],
        principals: [],
      },
      now: checked,
      recheckMs: 3_600_000,
    });

  beforeAll(async () => {
    container = await startClickHouse();
    ch = await fresh();
    world = await seedTokensWorld(ch, new LedgerWriter(ch, CTX));
  });

  afterAll(async () => {
    for (const svc of services) await svc.close();
    await container?.container.stop();
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe('a generation built by the pass', () => {
    let batches: number;
    let tokens: Map<string, TokensRow>;

    beforeAll(async () => {
      batches = await buildGeneration(ch, 1, world.head);
      tokens = await liveTokens(ch, 1);
    });

    it('the world has lines of the issuer as the low account and as the high account', () => {
      expect(world.issuerLow).toBeGreaterThan(5);
      expect(world.issuerHigh).toBeGreaterThan(5);
    });

    it('a fresh generation equals the brute force at the head', async () => {
      const expected = await bruteForceTokens(ch, world.head);
      // the world has the issuers' tokens (USD of two issuers, MYTOKEN, EUR, BTH of two, ABC, GON, and the holders that issue USD)
      expect(expected.size).toBeGreaterThan(8);
      expect(batches).toBeGreaterThan(5);
      expect([...tokens.keys()].sort()).toEqual([...expected.keys()].sort());
      for (const [key, want] of expected) {
        const token = tokens.get(key);
        expect({ holders: token?.holders, trust_lines: token?.trust_lines, supply: token?.supply }).toEqual(want);
      }
    });

    it('its lines are the wanted rows of every line, from the issuer side', async () => {
      const expected = await bruteForceLines(ch, world.head);
      const lines = await liveLines(ch, 1);
      expect([...lines.keys()].sort()).toEqual([...expected.keys()].sort());
      for (const [key, { line }] of expected) {
        const row = lines.get(key);
        expect({
          holder: row?.holder,
          balance: row?.balance,
          balance_f: row?.balance_f,
          limit: row?.limit,
          frozen: row?.frozen,
          authorized: row?.authorized,
          ledger_index: row?.ledger_index,
        }).toEqual({ ...line, balance_f: Number(line.balance) });
      }
      // the flags are the issuer side's: the world froze one line and authorized another
      expect([...lines.values()].filter((l) => l.frozen === 1)).toHaveLength(1);
      expect([...lines.values()].filter((l) => l.authorized === 1)).toHaveLength(1);
    });

    it('sums exactly what a float sum cannot hold together', () => {
      // 1e15 and 1e-15 among the holders of gate's USD: the 31 digits are all there
      expect(tokens.get(tokenOf(world.gate, world.usd))).toMatchObject({
        code: 'USD',
        holders: 23,
        trust_lines: 24,
        supply: '1000000000005477.500000100000001',
        last_ledger: world.head - 1,
      });
    });

    it('turns a line round, drops a deleted one and counts a line made again', () => {
      // the holders that issue USD themselves: one extended credit it has not used (a zero line), one that now owes gate 6
      const issuedByHolders = [...tokens.values()]
        .filter((t) => t.currency === world.usd && t.issuer !== world.gate && t.issuer !== world.plain)
        .map((t) => [t.holders, t.trust_lines, t.supply]);
      expect(issuedByHolders.sort()).toEqual([
        [0, 1, '0'],
        [1, 1, '6'],
      ]);
      // plain's USD: one holder at the head's 2, a zero line, and the pool's 700
      expect(tokens.get(tokenOf(world.plain, world.usd))).toMatchObject({ holders: 2, trust_lines: 3, supply: '702' });
    });

    it('takes the Float64 sum as the supply when an amount does not fit the exact sums', () => {
      // 1e40 (above the 1e36 the exact sums hold) and 5: the exact sum would leave the 1e40 out and say 5
      const token = tokens.get(tokenOf(world.nostate, world.huge));
      expect(token).toMatchObject({ holders: 2, trust_lines: 2, supply: '10000000000000000000000000000000000000000' });
      expect(token?.supply_f).toBe(1e40);
      // the others keep their exact sums
      expect(tokens.get(tokenOf(world.nostate, 'ABC'))?.supply).toBe('10');
    });

    it('counts a zero line with both limits above 0 for both tokens, and no LP line', async () => {
      for (const issuer of [world.gate, world.nodomain]) {
        expect(tokens.get(tokenOf(issuer, world.both))).toMatchObject({ holders: 0, trust_lines: 1, supply: '0' });
      }
      expect([...tokens.values()].filter((t) => t.currency === world.both)).toHaveLength(2);

      // the pool's LP line is in the state tables, and in no token
      const [stored] = await ch.query<{ lines: string }>(
        `SELECT count() AS lines FROM ${Table.TrustLineStates} WHERE currency = {lp:String}`,
        { lp: world.lp },
      );
      expect(Number(stored.lines)).toBeGreaterThan(0);
      expect([...tokens.values()].filter((t) => t.currency === world.lp)).toHaveLength(0);
      const [kept] = await ch.query<{ lines: string }>(
        `SELECT count() AS lines FROM ${Table.TokenLines} WHERE currency = {lp:String}`,
        { lp: world.lp },
      );
      expect(Number(kept.lines)).toBe(0);
    });

    it('counts an AMM pool as a holder', async () => {
      const lines = await liveLines(ch, 1);
      const gate = lines.get(lineMapKey({ issuer: world.gate, currency: world.usd }, world.pool));
      const plain = lines.get(lineMapKey({ issuer: world.plain, currency: world.usd }, world.pool));
      expect([gate?.balance, gate?.limit, plain?.balance]).toEqual(['5000', '0', '700']);
    });

    it('takes the issuer settings from its newest account_states row at the head, and 0 without one', () => {
      // gate: DefaultRipple and GlobalFreeze, a transfer rate of 1.002, set at rateNow
      expect(tokens.get(tokenOf(world.gate, world.usd))).toMatchObject({
        issuer_flags: world.gateFlags,
        transfer_rate: 1_002_000_000,
        issuer_ledger: world.rateNow,
      });
      // plain set its flags in the first ledger and never a rate
      expect(tokens.get(tokenOf(world.plain, world.usd))).toMatchObject({
        issuer_flags: 0x00800000,
        transfer_rate: 0,
        issuer_ledger: world.first,
      });
      // an issuer with no AccountRoot in any ledger, and one whose AccountRoot was deleted: the settings are unknown
      for (const issuer of [world.nostate, world.gone]) {
        const token = [...tokens.values()].find((t) => t.issuer === issuer);
        expect(token).toBeDefined();
        expect(token).toMatchObject({ issuer_flags: 0, transfer_rate: 0, issuer_ledger: 0 });
      }
    });

    it("lists a token only from its issuer's own domain's toml", () => {
      // gate's own toml lists USD and MYTOKEN; plain's toml lists gate's USD too, and that entry is ignored
      expect(tokens.get(tokenOf(world.gate, world.usd))).toMatchObject({
        domain: world.gateDomain,
        listed: 1,
        name: 'Gateway Dollar',
        toml: '{"name":"Gateway Dollar","icon":"https://gateway.example/usd.png","display_decimals":2}',
      });
      expect(tokens.get(tokenOf(world.gate, world.myToken))).toMatchObject({
        code: 'MYTOKEN',
        domain: world.gateDomain,
        listed: 1,
        name: 'My Token',
        toml: '{"name":"My Token","symbol":"MYT"}',
      });
      // plain has a domain whose toml does not list its USD
      expect(tokens.get(tokenOf(world.plain, world.usd))).toMatchObject({
        domain: world.plainDomain,
        listed: 0,
        name: '',
        toml: '',
      });
      // nodomain took its domain back; plain's toml lists its EUR, which no one but nodomain's own domain may do
      expect(tokens.get(tokenOf(world.nodomain, world.eur))).toMatchObject({
        domain: '',
        listed: 0,
        name: '',
        toml: '',
      });
      expect(tokens.get(tokenOf(world.nostate, 'ABC'))).toMatchObject({ domain: '', listed: 0 });
    });

    it('a generation at an earlier head equals the brute force at that head', async () => {
      // before the rate went down, after the lines were deleted and turned round, and at the first ledger
      let generation = 10;
      for (const head of [world.first, world.first + 2, world.rateNow]) {
        await buildGeneration(ch, generation, head);
        const expected = await bruteForceTokens(ch, head);
        const built = await liveTokens(ch, generation);
        expect(expected.size).toBeGreaterThan(3);
        expect([...built.keys()].sort()).toEqual([...expected.keys()].sort());
        for (const [key, want] of expected) {
          const token = built.get(key);
          expect({ holders: token?.holders, trust_lines: token?.trust_lines, supply: token?.supply }).toEqual(want);
        }
        generation++;
      }
      // the heads differ: the generation at the first ledger is not the one at the head
      expect((await bruteForceTokens(ch, world.first)).get(tokenOf(world.gate, world.usd))).not.toEqual(
        tokens.get(tokenOf(world.gate, world.usd)),
      );
    });

    it('writing a batch again leaves the same lines and tokens under newer versions', async () => {
      const lines = await liveLines(ch, 1);
      const accounts = await nextPassAccounts(ch, '', 1_000);
      const through = accounts[accounts.length - 1];
      const version = nextVersion();
      await writePassLines(ch, { generation: 1, after: '', through, head: world.head, version });
      const batchTokens = await passTokens(ch, { generation: 1, after: '', through });
      await recomputeTokens(ch, {
        generation: 1,
        tokens: batchTokens,
        atLedger: world.head,
        version,
        profile: PROFILE,
        rematch: 'all',
      });
      expect(await liveLines(ch, 1)).toEqual(lines);
      expect(await liveTokens(ch, 1)).toEqual(new Map([...tokens].map(([key, row]) => [key, { ...row, version }])));
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe('the pass', () => {
    it('nextPassAccounts walks the accounts in key order and stops after n', async () => {
      const rows = await ch.query<{ account: string }>(`SELECT DISTINCT account FROM ${Table.TrustLineStates}`);
      const all = rows.map((r) => r.account).sort();
      expect(all.length).toBeGreaterThan(30);

      expect(await nextPassAccounts(ch, '', 3)).toEqual(all.slice(0, 3));
      expect(await nextPassAccounts(ch, all[2], 3)).toEqual(all.slice(3, 6));
      // after an account that has no line, the next one that has
      expect(await nextPassAccounts(ch, `${all[4]}0`, 2)).toEqual(all.slice(5, 7));

      const walked: string[] = [];
      for (let after = ''; ; ) {
        const next = await nextPassAccounts(ch, after, 7);
        if (next.length === 0) break;
        walked.push(...next);
        after = next[next.length - 1];
      }
      expect(walked).toEqual(all);
      expect(await nextPassAccounts(ch, all[all.length - 1], 3)).toEqual([]);
      expect(await nextPassAccounts(ch, '', all.length + 10)).toEqual(all);
    });

    it('passTokens gives the tokens of the lines a batch wrote, in key order', async () => {
      const accounts = (await ch.query<{ account: string }>(`SELECT DISTINCT account FROM ${Table.TrustLineStates}`))
        .map((r) => r.account)
        .sort();
      // the batch after the first two accounts, up to the third from the last: most of the issuers, not all
      const after = accounts[2];
      const through = accounts[accounts.length - 3];
      const tokens = await passTokens(ch, { generation: 1, after, through });
      const expected = [...(await bruteForceLines(ch, world.head)).values()]
        .map((l) => l.token)
        .filter((t) => t.issuer > after && t.issuer <= through);
      const keys = (list: TokenKey[]): string[] => [...new Set(list.map(tokenMapKey))].sort();
      expect(tokens.map(tokenMapKey)).toEqual(keys(expected));
      expect(tokens.length).toBeGreaterThan(0);
    });

    it('the pass reads a key range of trust_line_states', async () => {
      const accounts = (await ch.query<{ account: string }>(`SELECT DISTINCT account FROM ${Table.TrustLineStates}`))
        .map((r) => r.account)
        .sort();
      const after = accounts[2];
      const through = accounts[accounts.length - 3];
      const plan = await ch.query<{ explain: string }>(`EXPLAIN indexes = 1 ${PASS_LINES_SELECT}`, {
        g: 1,
        after,
        through,
        head: world.head,
        version: '1',
      });
      const text = plan.map((r) => r.explain).join('\n');
      expect(text).toContain('PrimaryKey');
      const primary = text.slice(text.indexOf('PrimaryKey'));
      expect(primary).toMatch(/Keys:\s+account/);
      // both bounds of the range are in the primary key's condition: the batch is a range, not a prefix of the table
      expect(primary).toContain(`account in (-Inf, '${through}']`);
      expect(primary).toContain(`account in ('${after}', +Inf)`);
    });

    it('nextPassAccounts reads about a granule of each part, not every row after the cursor', async () => {
      // three parts that each hold the same 500 accounts (as parts of different ledgers do), merges stopped so that they stay
      const svc = await fresh();
      const db = (await svc.queryOne<{ db: string }>('SELECT currentDatabase() AS db'))?.db ?? '';
      await svc.command(`SYSTEM STOP MERGES ${db}.${Table.TrustLineStates}`);
      const PARTS = 3;
      const PER_ACCOUNT = 600;
      const ACCOUNTS = 500;
      for (let part = 0; part < PARTS; part++) {
        await svc.command(
          `INSERT INTO ${Table.TrustLineStates}
             (account, counterparty, currency, ledger_index, tx_index, node_index, tx_hash, close_time, balance, \`limit\`,
              limit_peer, no_ripple, no_ripple_peer, authorized, peer_authorized, freeze, peer_freeze, quality_in, quality_out,
              flags, deleted)
           SELECT concat('rA', leftPad(toString(intDiv(number, ${PER_ACCOUNT})), 6, '0')),
                  concat('rB', leftPad(toString(number % ${PER_ACCOUNT}), 6, '0')),
                  'USD', {ledger:UInt32}, 0, 0, '', now(), '-5', '0', '10', 0, 0, 0, 0, 0, 0, 0, 0, 0, 0
             FROM numbers(${ACCOUNTS * PER_ACCOUNT})`,
          { ledger: 100 + part },
        );
      }
      const [parts] = await svc.query<{ parts: string }>(
        `SELECT count() AS parts FROM system.parts WHERE database = {db:String} AND table = {table:String} AND active`,
        { db, table: Table.TrustLineStates },
      );
      expect(Number(parts.parts)).toBe(PARTS);

      const readRows = async (after: string): Promise<number> => {
        await svc.command('SYSTEM FLUSH LOGS');
        const [row] = await svc.query<{ read_rows: string }>(
          `SELECT read_rows FROM system.query_log
            WHERE type = 'QueryFinish' AND current_database = {db:String} AND startsWith(query, 'SELECT account')
              AND position(query, {cursor:String}) > 0
            ORDER BY event_time_microseconds DESC LIMIT 1`,
          { db, cursor: `account > '${after}'` },
        );
        return Number(row.read_rows);
      };

      for (const [after, first] of [
        ['', 'rA000000'],
        ['rA000250', 'rA000251'],
      ] as const) {
        const [{ remainder }] = await svc.query<{ remainder: string }>(
          `SELECT count() AS remainder FROM ${Table.TrustLineStates} WHERE account > {after:String}`,
          { after },
        );
        const accounts = await nextPassAccounts(svc, after, 3);
        expect(accounts).toEqual([first, ...accounts.slice(1)]);
        expect(accounts).toHaveLength(3);
        const rows = await readRows(after);
        // the rows after the cursor are 900,000 and 448,200: a batch of 3 accounts reads a granule or a few of each part (8,192 rows)
        expect(Number(remainder)).toBeGreaterThan(400_000);
        expect(rows).toBeLessThan(PARTS * 4 * 8_192);
      }
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe('the issuers', () => {
    it('issuerDomains gives the account domain of each issuer, lower case, and the empty text for none', async () => {
      const domains = await issuerDomains(ch, [world.gate, world.plain, world.nodomain, world.nostate, world.gate]);
      expect(domains).toEqual(
        new Map([
          [world.gate, 'gateway.example'],
          [world.plain, 'plain.example'],
          // named a domain, took it back: the newer row is a deletion
          [world.nodomain, ''],
          [world.nostate, ''],
        ]),
      );
      expect(await issuerDomains(ch, [])).toEqual(new Map());
    });

    it('takes the issuer settings at atLedger, not at the head', async () => {
      await buildGeneration(ch, 2, world.head);
      const tokens = [{ issuer: world.gate, currency: world.usd }];
      // before the rate went down and gate froze: the first transfer rate and the flags it had
      await recomputeTokens(ch, {
        generation: 2,
        tokens,
        atLedger: world.rateNow - 1,
        version: nextVersion(),
        profile: PROFILE,
        rematch: new Set(),
      });
      expect((await liveTokens(ch, 2)).get(tokenOf(world.gate, world.usd))).toMatchObject({
        issuer_flags: 0x00800000,
        transfer_rate: 1_005_000_000,
        issuer_ledger: world.rateFirst,
      });
      // before any AccountSet of gate: no row, the settings are unknown
      await recomputeTokens(ch, {
        generation: 2,
        tokens,
        atLedger: world.first - 1,
        version: nextVersion(),
        profile: PROFILE,
        rematch: new Set(),
      });
      expect((await liveTokens(ch, 2)).get(tokenOf(world.gate, world.usd))).toMatchObject({
        issuer_flags: 0,
        transfer_rate: 0,
        issuer_ledger: 0,
      });
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe('recomputeTokens', () => {
    const ISSUER = 'rRecomputeIssuerxxxxxxxxxxxxxxxxx';
    const OTHER = 'rRecomputeOtherIssuerxxxxxxxxxxxxx';
    const DOMAIN = 'recompute.example';
    const OTHER_DOMAIN = 'other-recompute.example';
    const line = (
      issuer: string,
      currency: string,
      holder: string,
      balance: string,
      version: string,
    ): TokenLinesRow => ({
      ...SAMPLE_ROWS[Table.TokenLines],
      generation: 7,
      issuer,
      currency,
      holder,
      balance,
      balance_f: Number(balance),
      ledger_index: 500,
      version,
    });

    it('gives a token that loses every line a deleted row, and nothing to one that never had a line', async () => {
      const svc = await fresh();
      const a = { issuer: ISSUER, currency: 'AAA' };
      const never = { issuer: ISSUER, currency: 'NVR' };
      await svc.insert(Table.TokenLines, [
        line(ISSUER, 'AAA', 'rHolder1', '5', '10'),
        line(ISSUER, 'AAA', 'rHolder2', '0', '10'),
      ]);
      const recompute = (version: string, tokens: TokenKey[]) =>
        recomputeTokens(svc, { generation: 7, tokens, atLedger: 600, version, profile: PROFILE, rematch: 'all' });

      await recompute('20', [a, never]);
      expect([...(await liveTokens(svc, 7)).values()]).toMatchObject([
        { currency: 'AAA', code: 'AAA', holders: 1, trust_lines: 2, supply: '5', last_ledger: 500 },
      ]);

      // both lines go: the tombstones are newer than the rows
      await svc.insert(Table.TokenLines, [
        { ...line(ISSUER, 'AAA', 'rHolder1', '5', '30'), deleted: 1 },
        { ...line(ISSUER, 'AAA', 'rHolder2', '0', '30'), deleted: 1 },
      ]);
      await recompute('40', [a, never]);
      expect(await liveTokens(svc, 7)).toEqual(new Map());
      const rows = await svc.query<{ currency: string; deleted: number; version_text: string }>(
        `SELECT currency, deleted, toString(version) AS version_text FROM ${Table.Tokens} ORDER BY currency, version`,
      );
      // the live row, then the deleted one: the token that never had a line has no row at all
      expect(rows).toEqual([
        { currency: 'AAA', deleted: 0, version_text: '20' },
        { currency: 'AAA', deleted: 1, version_text: '40' },
      ]);

      // nothing more for a token that is already deleted
      await recompute('50', [a]);
      expect(await svc.query(`SELECT 1 FROM ${Table.Tokens} WHERE version = 50`)).toEqual([]);

      // a line is back: the token is live again, and matched afresh
      await svc.insert(Table.TokenLines, [line(ISSUER, 'AAA', 'rHolder3', '2.5', '60')]);
      await recompute('70', [a]);
      expect([...(await liveTokens(svc, 7)).values()]).toMatchObject([{ holders: 1, trust_lines: 1, supply: '2.5' }]);
    });

    it('matches the listing afresh for the issuers to rematch, keeps it for the others and matches a token without a row', async () => {
      const svc = await fresh();
      const mine = { issuer: ISSUER, currency: 'AAA' };
      const other = { issuer: OTHER, currency: 'BBB' };
      await svc.insert(Table.TokenLines, [
        line(ISSUER, 'AAA', 'rHolder1', '5', '10'),
        line(OTHER, 'BBB', 'rHolder1', '6', '10'),
      ]);
      await svc.insert(Table.AccountDomains, [
        { ...SAMPLE_ROWS[Table.AccountDomains], account: ISSUER, domain_hex: hexOf(DOMAIN) },
        { ...SAMPLE_ROWS[Table.AccountDomains], account: OTHER, domain_hex: hexOf(OTHER_DOMAIN) },
      ]);
      await svc.insert(Table.DomainTomls, [
        tomlRow(DOMAIN, ISSUER, 'AAA', 'first name', 1_700_000_000),
        tomlRow(OTHER_DOMAIN, OTHER, 'BBB', 'other first name', 1_700_000_000),
      ]);
      const recompute = (version: string, tokens: TokenKey[], rematch: 'all' | ReadonlySet<string>) =>
        recomputeTokens(svc, { generation: 7, tokens, atLedger: 600, version, profile: PROFILE, rematch });

      await recompute('20', [mine, other], 'all');
      const names = async () =>
        Object.fromEntries(
          [...(await liveTokens(svc, 7)).values()].map((t) => [t.currency, [t.domain, t.listed, t.name]]),
        );
      expect(await names()).toEqual({ AAA: [DOMAIN, 1, 'first name'], BBB: [OTHER_DOMAIN, 1, 'other first name'] });

      // both tomls change; only the issuer named in rematch is matched again
      await svc.insert(Table.DomainTomls, [
        tomlRow(DOMAIN, ISSUER, 'AAA', 'second name', 1_700_000_100),
        tomlRow(OTHER_DOMAIN, OTHER, 'BBB', 'other second name', 1_700_000_100),
      ]);
      await recompute('30', [mine, other], new Set([OTHER]));
      expect(await names()).toEqual({ AAA: [DOMAIN, 1, 'first name'], BBB: [OTHER_DOMAIN, 1, 'other second name'] });
      await recompute('40', [mine, other], new Set());
      expect(await names()).toEqual({ AAA: [DOMAIN, 1, 'first name'], BBB: [OTHER_DOMAIN, 1, 'other second name'] });
      await recompute('50', [mine, other], 'all');
      expect(await names()).toEqual({ AAA: [DOMAIN, 1, 'second name'], BBB: [OTHER_DOMAIN, 1, 'other second name'] });

      // a token with no row is matched whatever rematch says
      const third = { issuer: ISSUER, currency: 'CCC' };
      await svc.insert(Table.TokenLines, [line(ISSUER, 'CCC', 'rHolder1', '1', '60')]);
      await svc.insert(Table.DomainTomls, [tomlRow(DOMAIN, ISSUER, 'CCC', 'third name', 1_700_000_200)]);
      await recompute('70', [third], new Set());
      expect((await liveTokens(svc, 7)).get(tokenOf(ISSUER, 'CCC'))).toMatchObject({
        domain: DOMAIN,
        listed: 1,
        name: 'third name',
      });
    });

    it('writes every row of a call under the version it is given', async () => {
      const svc = await fresh();
      await svc.insert(Table.TokenLines, [
        line(ISSUER, 'AAA', 'rHolder1', '5', '10'),
        line(ISSUER, 'BBB', 'rHolder1', '5', '10'),
        line(OTHER, 'AAA', 'rHolder1', '5', '10'),
      ]);
      const tokens = [
        { issuer: OTHER, currency: 'AAA' },
        { issuer: ISSUER, currency: 'BBB' },
        { issuer: ISSUER, currency: 'AAA' },
        { issuer: ISSUER, currency: 'AAA' },
      ];
      await recomputeTokens(svc, {
        generation: 7,
        tokens,
        atLedger: 600,
        version: '9007199254740993',
        profile: PROFILE,
        rematch: 'all',
      });
      const rows = await svc.query<{ issuer: string; currency: string; version_text: string }>(
        `SELECT issuer, currency, toString(version) AS version_text FROM ${Table.Tokens} ORDER BY issuer, currency`,
      );
      expect(rows).toHaveLength(3);
      expect(new Set(rows.map((r) => r.version_text))).toEqual(new Set(['9007199254740993']));
    });

    it('writes nothing once the signal is aborted', async () => {
      const svc = await fresh();
      await svc.insert(Table.TokenLines, [line(ISSUER, 'AAA', 'rHolder1', '5', '10')]);
      const controller = new AbortController();
      controller.abort();
      await expect(
        recomputeTokens(
          svc,
          {
            generation: 7,
            tokens: [{ issuer: ISSUER, currency: 'AAA' }],
            atLedger: 600,
            version: '20',
            profile: PROFILE,
            rematch: 'all',
          },
          controller.signal,
        ),
      ).rejects.toBeInstanceOf(TokensAborted);
      await expect(
        writePassLines(svc, { generation: 7, after: '', through: 'z', head: 600, version: '20' }, controller.signal),
      ).rejects.toBeInstanceOf(TokensAborted);
      await expect(
        writeTokenGeneration(svc, SAMPLE_ROWS[Table.TokenGenerations], controller.signal),
      ).rejects.toBeInstanceOf(TokensAborted);
      expect(await svc.query(`SELECT 1 FROM ${Table.Tokens}`)).toEqual([]);
      expect(await svc.query(`SELECT 1 FROM ${Table.TokenGenerations}`)).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe('a read that names more keys than a query parameter may hold', () => {
    // 2,001 tokens of 2,001 issuers, each with its own domain: one more than a chunk of keys, and four chunks of domains
    const COUNT = TOKENS_STATE_CHUNK + 1;
    const issuerOf = (n: number): string => `rBulkIssuer${String(n).padStart(5, '0')}xxxxxxxxxxxxxxxxxx`;
    const currencyOf = (n: number): string => `${n.toString(16).toUpperCase().padStart(8, '0')}${'AB'.repeat(16)}`;
    const domainOf = (n: number): string => `d${n}.example`;

    it('a chunk of keys and a chunk of domains fit a query parameter of 128 KiB', () => {
      // quoted and separated: 3 characters more than the key; an issuer is at most 35 characters, a currency 40, a domain 128
      const bytes = (keys: number, size: number): number => keys * (size + 3);
      expect(bytes(TOKENS_STATE_CHUNK, 40)).toBeLessThan(128 * 1024);
      expect(bytes(TOKENS_TOML_DOMAINS_CHUNK, 128)).toBeLessThan(128 * 1024);
      expect([TOKENS_PASS_ACCOUNTS, TOKENS_STATE_CHUNK, TOKENS_TOML_DOMAINS_CHUNK]).toEqual([500, 2_000, 500]);
    });

    it('reads the totals, the settings, the domains and the tomls of 2,001 tokens in chunks', async () => {
      const svc = await fresh();
      const numbers = Array.from({ length: COUNT }, (_, n) => n);
      const tokens: TokenKey[] = numbers.map((n) => ({ issuer: issuerOf(n), currency: currencyOf(n) }));
      expect(currencyOf(0)).toHaveLength(40);

      await svc.insert(
        Table.TokenLines,
        numbers.map((n) => ({
          ...SAMPLE_ROWS[Table.TokenLines],
          generation: 3,
          issuer: issuerOf(n),
          currency: currencyOf(n),
          holder: 'rBulkHolderxxxxxxxxxxxxxxxxxxxxxx',
          balance: '1',
          balance_f: 1,
          ledger_index: 50,
          version: '10',
        })),
      );
      await svc.insert(
        Table.AccountStates,
        numbers.map(
          (n): AccountStatesRow => ({
            ...SAMPLE_ROWS[Table.AccountStates],
            account: issuerOf(n),
            ledger_index: 40,
            flags: n + 1,
            fields: JSON.stringify({ TransferRate: 1_000_000_000 + n }),
          }),
        ),
      );
      await svc.insert(
        Table.AccountDomains,
        numbers.map((n) => ({
          ...SAMPLE_ROWS[Table.AccountDomains],
          account: issuerOf(n),
          domain_hex: Buffer.from(domainOf(n)).toString('hex').toUpperCase(),
        })),
      );
      await svc.insert(
        Table.DomainTomls,
        numbers.map((n) =>
          okTomlRow({
            domain: domainOf(n),
            tomlUrl: tomlUrlOf(domainOf(n), PROFILE),
            content: {
              modified: null,
              expires: null,
              accounts: [],
              currencies: [
                {
                  code: currencyOf(n),
                  issuer: issuerOf(n),
                  network: '',
                  fields: JSON.stringify({ name: `Token ${n}` }),
                },
              ],
              validators: [],
              principals: [],
            },
            now: 1_700_000_000,
            recheckMs: 3_600_000,
          }),
        ),
      );

      const spy = jest.spyOn(svc, 'query');
      let queried: Array<Record<string, unknown>> = [];
      try {
        await recomputeTokens(svc, {
          generation: 3,
          tokens,
          atLedger: 60,
          version: '20',
          profile: PROFILE,
          rematch: 'all',
        });
        // the sweep's read of the issuers' domains goes by chunks too
        const domains = await issuerDomains(
          svc,
          tokens.map((t) => t.issuer),
        );
        expect(domains.size).toBe(COUNT);
        expect(domains.get(issuerOf(COUNT - 1))).toBe(domainOf(COUNT - 1));
      } finally {
        // restoring clears the record of the calls
        queried = spy.mock.calls.map((call) => call[1] ?? {});
        spy.mockRestore();
      }

      // no array parameter is longer than its chunk, and the longest are exactly a chunk
      const arrays = (name: string): number[] =>
        queried.flatMap((params) => (Array.isArray(params[name]) ? [(params[name] as unknown[]).length] : []));
      for (const name of ['issuers', 'currencies']) {
        expect(Math.max(...arrays(name))).toBe(TOKENS_STATE_CHUNK);
      }
      expect(Math.max(...arrays('domains'))).toBe(TOKENS_TOML_DOMAINS_CHUNK);
      expect(arrays('domains').reduce((a, b) => a + b, 0)).toBe(COUNT);

      const rows = await liveTokens(svc, 3);
      expect(rows.size).toBe(COUNT);
      for (const n of [0, TOKENS_STATE_CHUNK - 1, TOKENS_STATE_CHUNK, COUNT - 1]) {
        expect(rows.get(tokenMapKey({ issuer: issuerOf(n), currency: currencyOf(n) }))).toMatchObject({
          holders: 1,
          trust_lines: 1,
          supply: '1',
          issuer_flags: n + 1,
          transfer_rate: 1_000_000_000 + n,
          issuer_ledger: 40,
          domain: domainOf(n),
          listed: 1,
          name: `Token ${n}`,
        });
      }
    });

    it('sweeps 2,001 tokens in a step of 2,000 and one of 1, with the domains read 500 at a time', async () => {
      const svc = await fresh();
      const numbers = Array.from({ length: COUNT }, (_, n) => n);
      // the rows say nothing of the toml (a generation built before the tomls were read); the store lists every token.
      // generation 3 is swept in the steps of a chunk, generation 4 in one step of more than a chunk
      for (const generation of [3, 4]) {
        await svc.insert(
          Table.Tokens,
          numbers.map((n) => ({
            ...SAMPLE_ROWS[Table.Tokens],
            generation,
            issuer: issuerOf(n),
            currency: currencyOf(n),
            domain: '',
            listed: 0,
            name: '',
            toml: '',
            deleted: 0,
            version: '10',
          })),
        );
      }
      await svc.insert(
        Table.AccountDomains,
        numbers.map((n) => ({
          ...SAMPLE_ROWS[Table.AccountDomains],
          account: issuerOf(n),
          domain_hex: Buffer.from(domainOf(n)).toString('hex').toUpperCase(),
        })),
      );
      await svc.insert(
        Table.DomainTomls,
        numbers.map((n) =>
          okTomlRow({
            domain: domainOf(n),
            tomlUrl: tomlUrlOf(domainOf(n), PROFILE),
            content: {
              modified: null,
              expires: null,
              accounts: [],
              currencies: [
                {
                  code: currencyOf(n),
                  issuer: issuerOf(n),
                  network: '',
                  fields: JSON.stringify({ name: `Token ${n}` }),
                },
              ],
              validators: [],
              principals: [],
            },
            now: 1_700_000_000,
            recheckMs: 3_600_000,
          }),
        ),
      );

      const spy = jest.spyOn(svc, 'query');
      /** The parameters of the reads `run` made. */
      const queriedBy = async (run: () => Promise<unknown>): Promise<Array<Record<string, unknown>>> => {
        const before = spy.mock.calls.length;
        await run();
        return spy.mock.calls.slice(before).map((call) => call[1] ?? {});
      };
      const arraysIn = (queried: Array<Record<string, unknown>>, name: string): number[] =>
        queried.flatMap((params) => (Array.isArray(params[name]) ? [(params[name] as unknown[]).length] : []));
      let first: Awaited<ReturnType<typeof tomlSweep>> | undefined;
      let second: Awaited<ReturnType<typeof tomlSweep>> | undefined;
      let whole: Awaited<ReturnType<typeof tomlSweep>> | undefined;
      let chunked: Array<Record<string, unknown>>;
      let single: Array<Record<string, unknown>>;
      try {
        chunked = await queriedBy(async () => {
          first = await tomlSweep(svc, { generation: 3, version: '20', profile: PROFILE });
          second = await tomlSweep(svc, { generation: 3, version: '21', profile: PROFILE, after: first.next });
        });
        single = await queriedBy(async () => {
          whole = await tomlSweep(svc, { generation: 4, version: '22', profile: PROFILE, limit: COUNT });
        });
      } finally {
        // restoring clears the record of the calls
        spy.mockRestore();
      }

      // the tokens are in key order, the issuers being zero-padded: a step of a chunk ends at the 2,000th, the next has the last
      expect(first?.rewritten).toBe(TOKENS_STATE_CHUNK);
      expect(first?.next).toEqual({
        issuer: issuerOf(TOKENS_STATE_CHUNK - 1),
        currency: currencyOf(TOKENS_STATE_CHUNK - 1),
      });
      expect(second).toEqual({ rewritten: 1, next: undefined });
      expect(whole).toEqual({ rewritten: COUNT, next: undefined });

      // no array parameter is longer than a chunk, and the longest are exactly one; the domains go 500 at a time, each once
      for (const queried of [chunked, single]) {
        for (const name of ['issuers', 'currencies']) {
          expect(Math.max(...arraysIn(queried, name))).toBe(TOKENS_STATE_CHUNK);
        }
        expect(Math.max(...arraysIn(queried, 'domains'))).toBe(TOKENS_TOML_DOMAINS_CHUNK);
        expect(arraysIn(queried, 'domains').reduce((a, b) => a + b, 0)).toBe(COUNT);
      }
      // the step of more than a chunk reads its rows to rewrite in a chunk and the one left over
      expect(arraysIn(single, 'currencies')).toEqual([TOKENS_STATE_CHUNK, 1]);

      for (const generation of [3, 4]) {
        const rows = await liveTokens(svc, generation);
        expect(rows.size).toBe(COUNT);
        for (const n of [0, TOKENS_TOML_DOMAINS_CHUNK, TOKENS_STATE_CHUNK - 1, TOKENS_STATE_CHUNK]) {
          expect(rows.get(tokenMapKey({ issuer: issuerOf(n), currency: currencyOf(n) }))).toMatchObject({
            domain: domainOf(n),
            listed: 1,
            name: `Token ${n}`,
            version: generation === 4 ? '22' : n < TOKENS_STATE_CHUNK ? '20' : '21',
          });
        }
      }
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe('the generations', () => {
    const gen = (generation: number, state: TokenGenerationsRow['state'], version: string): TokenGenerationsRow => ({
      ...SAMPLE_ROWS[Table.TokenGenerations],
      generation,
      state,
      version,
    });

    it('readTokenGenerations gives the newest row of each generation in order, with the version as text', async () => {
      const svc = await fresh();
      expect(await readTokenGenerations(svc)).toEqual([]);
      await writeTokenGeneration(svc, gen(2, 'building', '150'));
      await writeTokenGeneration(svc, { ...gen(1, 'building', '100'), account_cursor: 'rA', pass_done: 0 });
      await writeTokenGeneration(svc, { ...gen(1, 'live', '9007199254740993'), account_cursor: 'rZ', pass_done: 1 });
      await writeTokenGeneration(svc, { ...gen(1, 'building', '120'), account_cursor: 'rB' });

      const rows = await readTokenGenerations(svc);
      expect(rows.map((r) => [r.generation, r.state, r.version, r.account_cursor, r.pass_done])).toEqual([
        [1, 'live', '9007199254740993', 'rZ', 1],
        [2, 'building', '150', SAMPLE_ROWS[Table.TokenGenerations].account_cursor, 0],
      ]);
      // a row comes back as it was written, the times to the millisecond
      expect(rows[1]).toEqual(gen(2, 'building', '150'));
    });

    it('liveGenerationOf and buildingGenerationOf take the highest of their state', () => {
      const rows = [
        gen(1, 'retired', '1'),
        gen(2, 'live', '2'),
        gen(3, 'live', '3'),
        gen(4, 'building', '4'),
        gen(5, 'building', '5'),
      ];
      expect(liveGenerationOf(rows)?.generation).toBe(3);
      expect(buildingGenerationOf(rows)?.generation).toBe(5);
      expect(liveGenerationOf([...rows].reverse())?.generation).toBe(3);
      expect(liveGenerationOf([gen(1, 'retired', '1'), gen(2, 'building', '2')])).toBeUndefined();
      expect(buildingGenerationOf([gen(1, 'live', '1')])).toBeUndefined();
      expect(liveGenerationOf([])).toBeUndefined();
    });

    it('tokensVersionFloor is the highest version of the generations, and of the rows of those not retired', async () => {
      const svc = await fresh();
      expect(await tokensVersionFloor(svc)).toBe('0');

      await writeTokenGeneration(svc, gen(1, 'live', '1000'));
      await writeTokenGeneration(svc, gen(2, 'building', '2000'));
      expect(await tokensVersionFloor(svc)).toBe('2000');

      // the rows of a generation that is not retired count: the lines (spec 2.3: a version is above the key's newest) and the tokens
      const lineRow = (generation: number, version: string): TokenLinesRow => ({
        ...SAMPLE_ROWS[Table.TokenLines],
        generation,
        version,
      });
      await svc.insert(Table.TokenLines, [lineRow(1, '3000')]);
      expect(await tokensVersionFloor(svc)).toBe('3000');
      await svc.insert(Table.Tokens, [{ ...SAMPLE_ROWS[Table.Tokens], generation: 2, version: '4000' }]);
      expect(await tokensVersionFloor(svc)).toBe('4000');
      await svc.insert(Table.TokenLines, [lineRow(2, '9007199254740993')]);
      expect(await tokensVersionFloor(svc)).toBe('9007199254740993');

      // a retired generation is dropped and never read again: its rows are not the floor
      await svc.insert(Table.TokenLines, [lineRow(3, '9999999999999999')]);
      await svc.insert(Table.Tokens, [{ ...SAMPLE_ROWS[Table.Tokens], generation: 3, version: '9999999999999999' }]);
      await writeTokenGeneration(svc, gen(3, 'retired', '5000'));
      expect(await tokensVersionFloor(svc)).toBe('9007199254740993');
      // but its own row is a generation row, and counts
      await writeTokenGeneration(svc, gen(3, 'retired', '9007199254740995'));
      expect(await tokensVersionFloor(svc)).toBe('9007199254740995');
    });

    it('stateCoverageStart is one more than the newest ledger of an older parser, else the oldest ledger', async () => {
      const svc = await fresh();
      const store = (...stored: Array<[number, number]>): Promise<void> =>
        svc.insert(
          Table.Ledgers,
          stored.map(([ledger_index, parser_version]) => ({
            ...SAMPLE_ROWS[Table.Ledgers],
            ledger_index,
            ledger_hash: ledger_index.toString(16).toUpperCase().padStart(64, '0'),
            parser_version,
          })),
        );
      // no ledger: no coverage
      expect(await stateCoverageStart(svc)).toBeUndefined();
      // every ledger by a parser that writes the state tables: the oldest
      await store([20, PARSER_VERSION], [21, PARSER_VERSION]);
      expect(await stateCoverageStart(svc)).toBe(20);
      // an older parser's ledger (2: before trust_line_states) in the middle: coverage starts right above it
      await store([10, 2], [15, 2]);
      expect(await stateCoverageStart(svc)).toBe(16);
      await store([25, 1]);
      expect(await stateCoverageStart(svc)).toBe(26);
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe('applying touches', () => {
    const usdOf = (base: TokensWorld): TokenKey => ({ issuer: base.gate, currency: base.usd });

    /** A migrated database with the world and its second batch of ledgers: the touches of the second batch are what the tests apply. */
    async function twoBatches() {
      const svc = await fresh();
      const writer = new LedgerWriter(svc, CTX);
      const base = await seedTokensWorld(svc, writer);
      const more = await seedTokensWorldLater(writer, base);
      return { svc, base, more };
    }

    /**
     * Applies the touches of (from, head] to `generation` as the runner does, window by window: the line states, then the tokens of the
     * lines and of the issuers (rematched), all at the window's end. Returns the end of each window.
     */
    async function applyTouches(
      svc: ClickHouseService,
      generation: number,
      from: number,
      head: number,
      o: { window?: number; maxLines?: number } = {},
    ): Promise<number[]> {
      const ends: number[] = [];
      for (let through = from; through < head; ) {
        const window = await touchesOfWindow(svc, through, head, o);
        const version = nextVersion();
        const lineTokens = await applyLineStates(svc, {
          generation,
          lines: window.lines,
          atLedger: window.to,
          version,
        });
        const issuerTokens = await tokensOfIssuers(svc, generation, window.issuers);
        await recomputeTokens(svc, {
          generation,
          tokens: [...lineTokens, ...issuerTokens],
          atLedger: window.to,
          version,
          profile: PROFILE,
          rematch: new Set(window.issuers),
        });
        through = window.to;
        ends.push(through);
      }
      return ends;
    }

    /** One window applied at `atLedger`, which is the window's end for a window that moves on and the generation's `through_ledger` for a repair. */
    async function applyWindow(
      svc: ClickHouseService,
      generation: number,
      window: { to: number; lines: LineKey[]; issuers: string[] },
      atLedger: number,
    ): Promise<void> {
      const version = nextVersion();
      const lineTokens = await applyLineStates(svc, { generation, lines: window.lines, atLedger, version });
      const issuerTokens = await tokensOfIssuers(svc, generation, window.issuers);
      await recomputeTokens(svc, {
        generation,
        tokens: [...lineTokens, ...issuerTokens],
        atLedger,
        version,
        profile: PROFILE,
        rematch: new Set(window.issuers),
      });
    }

    /** The rows of a token's line as the table keeps them, newest first: the history of one key. */
    interface LineHistory {
      balance: string;
      limit: string;
      ledger_index: number;
      deleted: number;
      version_text: string;
    }
    async function historyOf(svc: ClickHouseService, generation: number, token: TokenKey, holder: string) {
      return svc.query<LineHistory>(
        `SELECT balance, \`limit\`, ledger_index, deleted, toString(version) AS version_text
           FROM ${Table.TokenLines}
          WHERE generation = {generation:UInt32} AND issuer = {issuer:String} AND currency = {currency:String}
                AND holder = {holder:String}
          ORDER BY version DESC`,
        { generation, issuer: token.issuer, currency: token.currency, holder },
      );
    }

    /** The newest row of each line of a generation with its version, tombstones included, by `lineMapKey`. */
    async function newestLines(svc: ClickHouseService, generation: number): Promise<Map<string, TokenLinesRow>> {
      const rows = await svc.query<Omit<TokenLinesRow, 'version'> & { version_text: string }>(
        `SELECT issuer, currency, holder, balance, balance_f, \`limit\`, frozen, authorized, ledger_index, deleted,
                toString(version) AS version_text
           FROM ${Table.TokenLines}
          WHERE generation = {generation:UInt32}
          ORDER BY issuer, currency, holder, version DESC
          LIMIT 1 BY issuer, currency, holder`,
        { generation },
      );
      return new Map(
        rows.map(({ version_text, ...row }) => [lineMapKey(row, row.holder), { ...row, version: version_text }]),
      );
    }

    /** The live tokens of a generation without their version (it is the clock of the write that made them). */
    async function tokensWithoutVersion(svc: ClickHouseService, generation: number) {
      return new Map([...(await liveTokens(svc, generation))].map(([key, { version, ...row }]) => [key, row]));
    }

    /** The live lines and tokens of two generations, every column but the generation and the version, are the same. */
    async function expectSameGenerations(svc: ClickHouseService, a: number, b: number): Promise<void> {
      const lines = await liveLines(svc, b);
      expect(lines.size).toBeGreaterThan(30);
      expect(await liveLines(svc, a)).toEqual(lines);
      const tokens = await tokensWithoutVersion(svc, b);
      expect(tokens.size).toBeGreaterThan(8);
      expect(await tokensWithoutVersion(svc, a)).toEqual(tokens);
    }

    const keysOf = (tokens: readonly TokenKey[]): string[] => tokens.map(tokenMapKey).sort();

    // -----------------------------------------------------------------------------------------------------------------
    it('an incremental generation equals a fresh one built at the same head, row for row', async () => {
      const { svc, base, more } = await twoBatches();
      await buildGeneration(svc, 1, base.head);
      await buildGeneration(svc, 2, more.head);
      // the second batch changes what the generation says, so that the equality below is not the first generation's own
      expect(await liveLines(svc, 1)).not.toEqual(await liveLines(svc, 2));
      expect(await tokensWithoutVersion(svc, 1)).not.toEqual(await tokensWithoutVersion(svc, 2));

      // one ledger a window: four windows, the line changed twice is applied twice
      expect(await applyTouches(svc, 1, base.head, more.head, { window: 1 })).toEqual(more.ledgers);
      await expectSameGenerations(svc, 1, 2);

      // and the oracle at the new head says the same of the counts
      const expected = await bruteForceTokens(svc, more.head);
      const tokens = await liveTokens(svc, 1);
      expect([...tokens.keys()].sort()).toEqual([...expected.keys()].sort());
      for (const [key, want] of expected) {
        expect({ holders: tokens.get(key)?.holders, trust_lines: tokens.get(key)?.trust_lines }).toMatchObject({
          holders: want.holders,
          trust_lines: want.trust_lines,
        });
        expect(tokens.get(key)?.supply).toBe(want.supply);
      }
      // the new token is there, the line that turned round and back is not a line of its holder's token
      expect(tokens.get(tokenOf(base.plain, more.newCurrency))).toMatchObject({ holders: 1, supply: '3' });
      expect(tokens.get(tokenOf(more.turnedRound, base.usd))).toBeUndefined();
      const [firstStep, lastStep] = more.rateSteps;
      expect(firstStep.ledger).toBe(more.first);
      expect(tokens.get(tokenOf(base.gate, base.usd))).toMatchObject({
        transfer_rate: lastStep.rate,
        issuer_ledger: lastStep.ledger,
      });
      // the line made in the second batch and the line of the new token, each as a row of its own
      const lines = await liveLines(svc, 1);
      expect(lines.get(lineMapKey(usdOf(base), more.made))).toMatchObject({ balance: '77', ledger_index: more.first });
      expect(lines.get(lineMapKey({ issuer: base.plain, currency: more.newCurrency }, more.newHolder))).toMatchObject({
        balance: '3',
        ledger_index: more.first,
      });
    });

    it('gives the same rows whatever the size of the windows', async () => {
      const { svc, base, more } = await twoBatches();
      await buildGeneration(svc, 1, more.head);

      // two ledgers a window
      await buildGeneration(svc, 2, base.head);
      expect(await applyTouches(svc, 2, base.head, more.head, { window: 2 })).toEqual([more.first + 1, more.head]);
      await expectSameGenerations(svc, 2, 1);

      // one window of all four ledgers: the line changed twice is applied once, at the end, and the one that turned round and back too
      await buildGeneration(svc, 3, base.head);
      expect(await applyTouches(svc, 3, base.head, more.head)).toEqual([more.head]);
      await expectSameGenerations(svc, 3, 1);

      // windows halved while they hold more than three lines: one ledger of 4 lines, then one of 2, then the last two ledgers (3)
      await buildGeneration(svc, 4, base.head);
      expect(await applyTouches(svc, 4, base.head, more.head, { maxLines: 3 })).toEqual([
        more.first,
        more.first + 1,
        more.head,
      ]);
      await expectSameGenerations(svc, 4, 1);
    });

    it('turns a line round: a tombstone for one token, a row for the other', async () => {
      const { svc, base, more } = await twoBatches();
      await buildGeneration(svc, 1, base.head);
      const gate = usdOf(base);
      const holders: TokenKey = { issuer: more.turnedRound, currency: base.usd };
      const before = await liveLines(svc, 1);
      expect(before.get(lineMapKey(gate, more.turnedRound))).toMatchObject({ balance: '250', limit: '1000' });
      expect(before.has(lineMapKey(holders, base.gate))).toBe(false);

      // the ledger it turns round in: 250 becomes -4, so that the holder now owes gate 4
      const window = await touchesOfWindow(svc, more.first, more.first + 1);
      const version = nextVersion();
      const tokens = await applyLineStates(svc, { generation: 1, lines: window.lines, atLedger: window.to, version });
      // both tokens of the line are named, the one that lost its row and the one that got it
      expect(keysOf(tokens)).toEqual(expect.arrayContaining(keysOf([gate, holders])));

      const history = await historyOf(svc, 1, gate, more.turnedRound);
      expect(history.map((h) => [h.deleted, h.version_text])).toEqual([
        [1, version],
        [0, expect.any(String)],
      ]);
      expect(await historyOf(svc, 1, holders, base.gate)).toEqual([
        { balance: '4', limit: '0', ledger_index: more.first + 1, deleted: 0, version_text: version },
      ]);
      const after = await liveLines(svc, 1);
      expect(after.has(lineMapKey(gate, more.turnedRound))).toBe(false);
      expect(after.get(lineMapKey(holders, base.gate))).toMatchObject({ balance: '4', limit: '0', frozen: 0 });

      // it turns back in the next ledger: the row of the holder's token goes, gate's comes back
      const back = await touchesOfWindow(svc, more.first + 2, more.head);
      await applyLineStates(svc, { generation: 1, lines: back.lines, atLedger: back.to, version: nextVersion() });
      const again = await liveLines(svc, 1);
      expect(again.get(lineMapKey(gate, more.turnedRound))).toMatchObject({ balance: '7', limit: '1000' });
      expect(again.has(lineMapKey(holders, base.gate))).toBe(false);
    });

    it('writes a tombstone for a deleted line and for one emptied with no limit', async () => {
      const { svc, base, more } = await twoBatches();
      await buildGeneration(svc, 1, base.head);
      const gate = usdOf(base);
      const deleted = lineMapKey(gate, more.deleted);
      const emptied = lineMapKey(gate, more.emptied);
      const before = await newestLines(svc, 1);
      expect(before.get(deleted)).toMatchObject({ balance: '0.0000001', limit: '10', deleted: 0 });
      expect(before.get(emptied)).toMatchObject({ balance: '5', limit: '0', deleted: 0 });

      // the ledger of the deletion: the line is gone from the state, its final fields still show a balance
      const first = await touchesOfWindow(svc, base.head, more.first);
      let version = nextVersion();
      await applyLineStates(svc, { generation: 1, lines: first.lines, atLedger: first.to, version });
      const mid = await newestLines(svc, 1);
      expect(mid.get(deleted)).toMatchObject({ deleted: 1, version, ledger_index: more.first });
      // the emptied line is not touched yet
      expect(mid.get(emptied)).toEqual(before.get(emptied));

      // the ledger it is emptied in: a balance of 0 with a limit of 0 counts for no one
      const second = await touchesOfWindow(svc, more.first, more.first + 1);
      version = nextVersion();
      await applyLineStates(svc, { generation: 1, lines: second.lines, atLedger: second.to, version });
      const after = await newestLines(svc, 1);
      expect(after.get(emptied)).toMatchObject({ deleted: 1, version, ledger_index: more.first + 1 });
      expect(after.get(deleted)).toEqual(mid.get(deleted));
      // the other side of both lines never counted: the issuer extended no credit, so there is no row for it, not even a tombstone
      for (const holder of [more.deleted, more.emptied]) {
        expect(after.has(lineMapKey({ issuer: holder, currency: base.usd }, base.gate))).toBe(false);
      }
      const live = await liveLines(svc, 1);
      expect(live.has(deleted) || live.has(emptied)).toBe(false);
    });

    it('treats a line with no state row at or before atLedger as deleted', async () => {
      const { svc, base, more } = await twoBatches();
      await buildGeneration(svc, 1, base.head);
      const window = await touchesOfWindow(svc, more.first, more.first + 1);
      // before the first ledger of the world: a re-ingest removed the rows of these lines
      const version = nextVersion();
      const tokens = await applyLineStates(svc, {
        generation: 1,
        lines: window.lines,
        atLedger: base.first - 1,
        version,
      });
      expect(tokens.length).toBeGreaterThan(0);
      const newest = await newestLines(svc, 1);
      for (const holder of [more.turnedRound, more.emptied]) {
        expect(newest.get(lineMapKey(usdOf(base), holder))).toMatchObject({ deleted: 1, version });
      }
    });

    it('applying a window twice changes nothing', async () => {
      const { svc, base, more } = await twoBatches();
      await buildGeneration(svc, 1, base.head);
      const window = await touchesOfWindow(svc, base.head, more.head, { window: 2 });
      expect(window.to).toBe(more.first + 1);
      const first = nextVersion();
      const tokens = await applyLineStates(svc, {
        generation: 1,
        lines: window.lines,
        atLedger: window.to,
        version: first,
      });
      await recomputeTokens(svc, {
        generation: 1,
        tokens,
        atLedger: window.to,
        version: first,
        profile: PROFILE,
        rematch: new Set(window.issuers),
      });
      const lines = await newestLines(svc, 1);
      const written = Number((await svc.query<{ n: string }>(`SELECT count() AS n FROM ${Table.TokenLines}`))[0].n);
      const tokenRows = await tokensWithoutVersion(svc, 1);

      const second = nextVersion();
      const again = await applyLineStates(svc, {
        generation: 1,
        lines: window.lines,
        atLedger: window.to,
        version: second,
      });
      expect(keysOf(again)).toEqual(keysOf(tokens));
      // not one new row, so not one new version for a key: the newest rows are the same, versions included
      expect(await newestLines(svc, 1)).toEqual(lines);
      expect(Number((await svc.query<{ n: string }>(`SELECT count() AS n FROM ${Table.TokenLines}`))[0].n)).toBe(
        written,
      );
      expect([...lines.values()].some((row) => row.version === first)).toBe(true);
      expect([...lines.values()].some((row) => row.version === second)).toBe(false);

      // the tokens are written again under the newer version and say the same
      await recomputeTokens(svc, {
        generation: 1,
        tokens: again,
        atLedger: window.to,
        version: second,
        profile: PROFILE,
        rematch: new Set(window.issuers),
      });
      expect(await tokensWithoutVersion(svc, 1)).toEqual(tokenRows);
    });

    it("an account touch recomputes the issuer's tokens with its new TransferRate and domain", async () => {
      const { svc, base, more } = await twoBatches();
      await buildGeneration(svc, 1, base.head);
      const before = await liveTokens(svc, 1);
      const myToken = tokenOf(base.gate, base.myToken);
      expect(before.get(myToken)).toMatchObject({
        transfer_rate: base.gateRate,
        issuer_ledger: base.rateNow,
        domain: base.gateDomain,
        listed: 1,
        name: 'My Token',
      });

      // gate moves to another domain, whose toml lists MYTOKEN under another name and no other token (D4's workers write these rows)
      await svc.insert(Table.AccountDomains, [
        {
          ...SAMPLE_ROWS[Table.AccountDomains],
          account: base.gate,
          ledger_index: more.first,
          tx_index: 0,
          node_index: 0,
          version: String(BigInt(more.first) << 32n),
          domain_hex: hexOf('moved.example'),
          deleted: 0,
        },
      ]);
      await svc.insert(Table.DomainTomls, [
        tomlRow('moved.example', base.gate, 'MYTOKEN', 'My Token, moved', 1_700_000_000.5),
      ]);

      // the ledger of its AccountSet: the window also holds lines of gate's USD, but none of MYTOKEN or BTH
      const window = await touchesOfWindow(svc, base.head, more.first);
      expect(window.issuers).toEqual([base.gate]);
      await applyWindow(svc, 1, window, window.to);

      const after = await liveTokens(svc, 1);
      for (const [key, listed, name] of [
        [myToken, 1, 'My Token, moved'],
        [tokenOf(base.gate, base.both), 0, ''],
        [tokenOf(base.gate, base.usd), 0, ''],
      ] as const) {
        expect(after.get(key)).toMatchObject({
          transfer_rate: more.rateSteps[0].rate,
          issuer_ledger: more.rateSteps[0].ledger,
          issuer_flags: base.gateFlags,
          domain: 'moved.example',
          listed,
          name,
        });
      }
      // the tokens of an issuer the window does not touch are not written again
      for (const key of [tokenOf(base.plain, base.usd), tokenOf(base.nodomain, base.eur)]) {
        expect(after.get(key)).toEqual(before.get(key));
      }
    });

    it('a line changed in the repaired window and again later keeps its later state after the first window', async () => {
      const { svc, base, more } = await twoBatches();
      await buildGeneration(svc, 1, base.head);
      await applyTouches(svc, 1, base.head, more.head, { window: 1 });
      const twice = lineMapKey(usdOf(base), more.changedTwice);
      const gate = tokenOf(base.gate, base.usd);
      const lines = await liveLines(svc, 1);
      const tokens = await tokensWithoutVersion(svc, 1);
      // the line was changed in the first window (150) and again in the third (180), and gate's rate went up in the same two
      expect(lines.get(twice)).toMatchObject({ balance: '180', ledger_index: more.first + 2 });
      const [firstStep, lastStep] = more.rateSteps;
      expect(tokens.get(gate)).toMatchObject({ transfer_rate: lastStep.rate, issuer_ledger: lastStep.ledger });

      // the repair of the first window, which the generation is past: it reads at the generation's through_ledger
      const window = await touchesOfWindow(svc, base.head, more.head, { window: 1 });
      expect(window.to).toBe(more.first);
      expect(window.lines.length).toBeGreaterThan(2);
      expect(window.issuers).toEqual([base.gate]);
      await applyWindow(svc, 1, window, more.head);
      expect(await liveLines(svc, 1)).toEqual(lines);
      expect(await tokensWithoutVersion(svc, 1)).toEqual(tokens);

      // read at the window's own end, the same repair would put the line and the rate back to what they were then
      await applyWindow(svc, 1, window, window.to);
      expect((await liveLines(svc, 1)).get(twice)).toMatchObject({ balance: '150', ledger_index: more.first });
      expect((await liveTokens(svc, 1)).get(gate)).toMatchObject({
        transfer_rate: firstStep.rate,
        issuer_ledger: firstStep.ledger,
      });
      // and at the through_ledger once more it is right again
      await applyWindow(svc, 1, window, more.head);
      expect(await liveLines(svc, 1)).toEqual(lines);
      expect(await tokensWithoutVersion(svc, 1)).toEqual(tokens);
    });

    it('writes nothing once the signal is aborted', async () => {
      const { svc, base, more } = await twoBatches();
      await buildGeneration(svc, 1, base.head);
      const window = await touchesOfWindow(svc, base.head, more.head);
      const before = await newestLines(svc, 1);
      const controller = new AbortController();
      controller.abort();
      await expect(
        applyLineStates(
          svc,
          { generation: 1, lines: window.lines, atLedger: window.to, version: nextVersion() },
          controller.signal,
        ),
      ).rejects.toBeInstanceOf(TokensAborted);
      expect(await newestLines(svc, 1)).toEqual(before);
    });

    // -----------------------------------------------------------------------------------------------------------------
    describe('touchesOfWindow', () => {
      it('halves a window that holds more than maxLines lines', async () => {
        const { svc, base, more } = await twoBatches();
        // the four ledgers hold 4, 2, 2 and 1 line touches: 7 distinct lines in all, 6 in the first two ledgers
        const whole = await touchesOfWindow(svc, base.head, more.head, { window: 500, maxLines: 100 });
        expect(whole.to).toBe(more.head);
        expect(whole.lines).toHaveLength(7);
        expect(whole.issuers).toEqual([base.gate]);

        const six = await touchesOfWindow(svc, base.head, more.head, { window: 500, maxLines: 6 });
        expect(six.to).toBe(more.first + 1);
        expect(six.lines).toHaveLength(6);

        // 3 lines: the two ledgers hold 6, so the window is halved to one ledger, which holds 4: a ledger is never halved
        const three = await touchesOfWindow(svc, base.head, more.head, { window: 500, maxLines: 3 });
        expect(three.to).toBe(more.first);
        expect(three.to).toBeLessThan(more.head);
        expect(three.lines).toHaveLength(4);
        expect(three.issuers).toEqual([base.gate]);

        // the window is the size asked, and the head is not passed
        const two = await touchesOfWindow(svc, base.head, more.head, { window: 2 });
        expect(two.to).toBe(more.first + 1);
        expect((await touchesOfWindow(svc, more.first + 2, more.head, { window: 500 })).to).toBe(more.head);
        // a window at the head is empty
        expect(await touchesOfWindow(svc, more.head, more.head)).toEqual({ to: more.head, lines: [], issuers: [] });
      });

      it('lists the distinct lines in key order, drops the LP lines and names the issuers of the account touches', async () => {
        // the last two ledgers of the world's first batch: the pool's lines (one of them an LP token's), gone's AccountDelete and changes
        const window = await touchesOfWindow(ch, world.first + 3, world.head);
        const [stored] = await ch.query<{ n: string }>(
          `SELECT count() AS n FROM ${Table.StateTouches} WHERE currency = {lp:String}`,
          { lp: world.lp },
        );
        expect(Number(stored.n)).toBeGreaterThan(0);
        expect(window.lines.some((line) => line.currency === world.lp)).toBe(false);
        expect(window.lines.length).toBeGreaterThan(4);
        const order = window.lines.map((line) => JSON.stringify([line.account, line.counterparty, line.currency]));
        expect(order).toEqual([...order].sort());
        expect(new Set(order).size).toBe(order.length);
        // the pool's lines of USD and the lines of the huge currency are there
        expect(window.lines.map((line) => line.currency)).toEqual(expect.arrayContaining([world.usd, world.huge]));
        expect(window.issuers).toEqual([world.gone]);
        // an AccountSet is an account touch and not a line: the ledger of gate's second one holds one line and one issuer
        const rate = await touchesOfWindow(ch, world.rateNow - 1, world.rateNow);
        expect(rate.lines).toHaveLength(1);
        expect(rate.issuers).toEqual([world.gate]);
      });
    });

    describe('the lines of a window', () => {
      const LEDGERS = 300;
      const PER_LEDGER = 2_000;

      /** A table whose accounts fall as the ledgers rise: the order of the table is not the key order. */
      async function fallingTouches(): Promise<ClickHouseService> {
        const svc = await fresh();
        await svc.command(
          `INSERT INTO ${Table.StateTouches} (ledger_index, tx_index, kind, account, counterparty, currency)
           SELECT intDiv(number, ${PER_LEDGER}) + 1, 0, 'line',
                  concat('rLow', leftPad(toString(${LEDGERS * PER_LEDGER} - number), 8, '0')), 'rHigh', 'USD'
             FROM numbers(${LEDGERS * PER_LEDGER})`,
        );
        return svc;
      }

      it('are put in key order by the job, whatever the order of the table', async () => {
        const svc = await fallingTouches();
        const window = await touchesOfWindow(svc, 0, 3);
        expect(window.to).toBe(3);
        expect(window.lines).toHaveLength(3 * PER_LEDGER);
        // the table lists the first ledger's accounts first, and they are the highest: the lowest account is the third ledger's
        const order = window.lines.map((line) => JSON.stringify([line.account, line.counterparty, line.currency]));
        expect(order).toEqual([...order].sort());
        expect(window.lines[0].account).toBe(
          `rLow${String(LEDGERS * PER_LEDGER - 3 * PER_LEDGER + 1).padStart(8, '0')}`,
        );

        // a window of one ledger is read whole whatever it holds, and sorted too
        const one = await touchesOfWindow(svc, 5, LEDGERS, { window: 100, maxLines: 10 });
        expect(one.to).toBe(6);
        expect(one.lines).toHaveLength(PER_LEDGER);
        const oneOrder = one.lines.map((line) => line.account);
        expect(oneOrder).toEqual([...oneOrder].sort());
      });

      it('finds out that a window holds too many lines by reading some of them, not all', async () => {
        const svc = await fallingTouches();
        const queryId = `window-lines-${Date.now()}`;
        const read = await svc.raw.query({
          query: WINDOW_LINES_SQL,
          query_params: { from: 0, to: LEDGERS, limit: 101 },
          query_id: queryId,
          format: 'JSONEachRow',
          // each stream of the read takes a block before the limit stops it: a few streams, so that the count is the same on any machine
          clickhouse_settings: { max_threads: 2 },
        });
        expect(await read.json()).toHaveLength(101);
        await svc.command('SYSTEM FLUSH LOGS');
        const [log] = await svc.query<{ read_rows: string }>(
          `SELECT read_rows FROM system.query_log WHERE type = 'QueryFinish' AND query_id = {queryId:String}`,
          { queryId },
        );
        // the window holds 600,000 touches; with an ORDER BY the read takes every one of them (measured 600,000, against 221,184 without it)
        expect(Number(log.read_rows)).toBeLessThan((LEDGERS * PER_LEDGER) / 2);
      });
    });

    describe('parserFloorOf', () => {
      it('gives the lowest version of the window', async () => {
        const { svc, base, more } = await twoBatches();
        expect(await parserFloorOf(svc, base.first - 1, more.head)).toBe(PARSER_VERSION);
        // one ledger is written again by an older parser
        await svc.command(
          `INSERT INTO ${Table.Ledgers} SELECT * REPLACE (7 AS parser_version) FROM ${Table.Ledgers} WHERE ledger_index = {ledger:UInt32}`,
          { ledger: base.first + 2 },
        );
        expect(await parserFloorOf(svc, base.first - 1, more.head)).toBe(7);
        // the window is (from, to]: it holds the ledger at `to` and not the one at `from`
        expect(await parserFloorOf(svc, base.first + 1, base.first + 2)).toBe(7);
        expect(await parserFloorOf(svc, base.first + 2, more.head)).toBe(PARSER_VERSION);
        expect(await parserFloorOf(svc, base.first - 1, base.first + 1)).toBe(PARSER_VERSION);
      });

      it('is null when the window has no ledger', async () => {
        const { svc, base, more } = await twoBatches();
        expect(await parserFloorOf(svc, more.head, more.head + 100)).toBeNull();
        expect(await parserFloorOf(svc, base.first + 1, base.first + 1)).toBeNull();
        expect(await parserFloorOf(svc, 0, base.first - 1)).toBeNull();
      });
    });

    describe('tokensOfIssuers', () => {
      it('gives the tokens of the issuers in a generation, the deleted ones included, in key order', async () => {
        const svc = await fresh();
        const token = (issuer: string, currency: string, version: string, deleted = 0): TokensRow => ({
          ...SAMPLE_ROWS[Table.Tokens],
          generation: 4,
          issuer,
          currency,
          deleted,
          version,
        });
        await svc.insert(Table.Tokens, [
          token('rIssuerB', 'USD', '10'),
          token('rIssuerA', 'USD', '10'),
          // written twice: one token
          token('rIssuerA', 'USD', '20'),
          token('rIssuerA', 'EUR', '10'),
          // its newest row is a deletion: still a token of the issuer
          token('rIssuerA', 'GON', '10'),
          token('rIssuerA', 'GON', '30', 1),
          token('rIssuerC', 'USD', '10'),
          // another generation
          { ...token('rIssuerA', 'BTC', '10'), generation: 5 },
        ]);
        expect(await tokensOfIssuers(svc, 4, ['rIssuerA', 'rIssuerB', 'rNobody'])).toEqual([
          { issuer: 'rIssuerA', currency: 'EUR' },
          { issuer: 'rIssuerA', currency: 'GON' },
          { issuer: 'rIssuerA', currency: 'USD' },
          { issuer: 'rIssuerB', currency: 'USD' },
        ]);
        expect(await tokensOfIssuers(svc, 4, [])).toEqual([]);
        expect(await tokensOfIssuers(svc, 6, ['rIssuerA'])).toEqual([]);
      });
    });

    // -----------------------------------------------------------------------------------------------------------------
    it('reads a key range of state_touches and key prefixes of trust_line_states', async () => {
      // the plan's primary key section of a read: it is there only when the read uses the index
      const primaryOf = async (
        svc: ClickHouseService,
        sql: string,
        params: Record<string, unknown>,
      ): Promise<string> => {
        const text = (await svc.query<{ explain: string }>(`EXPLAIN indexes = 1 ${sql}`, params))
          .map((r) => r.explain)
          .join('\n');
        expect(text).toContain('PrimaryKey');
        return text.slice(text.indexOf('PrimaryKey'));
      };

      // the touches of the window (from, to] and the parser floor of its ledgers: a range of the first column of the key
      for (const sql of [WINDOW_LINES_SQL, WINDOW_ISSUERS_SQL, PARSER_FLOOR_SQL]) {
        const primary = await primaryOf(ch, sql, { from: world.first + 1, to: world.first + 3, limit: 5 });
        expect(primary).toMatch(/Keys:\s+ledger_index/);
        // `ledger_index > from` on an integer column is `ledger_index >= from + 1` to the index
        expect(primary).toContain(`ledger_index in [${world.first + 2}, +Inf)`);
        expect(primary).toContain(`ledger_index in (-Inf, ${world.first + 3}]`);
      }

      // the line states: the key (account, counterparty, currency) of the lines named, not a scan of the table
      const lines = await primaryOf(ch, LINE_STATES_SQL, {
        accounts: [world.gate, world.plain],
        counterparties: [world.pool, world.pool],
        currencies: [world.usd, world.usd],
        at: world.head,
      });
      expect(lines).toMatch(/Keys:\s+account\s+counterparty\s+currency/);
      expect(lines).toContain('(account, counterparty, currency) in 2-element set');
      expect(lines).toContain(`ledger_index in (-Inf, ${world.head}]`);

      // the stored lines and the tokens of the issuers: the key of token_lines and tokens, in one generation
      const svc = await fresh();
      await svc.insert(Table.TokenLines, [{ ...SAMPLE_ROWS[Table.TokenLines], generation: 1 }]);
      await svc.insert(Table.Tokens, [{ ...SAMPLE_ROWS[Table.Tokens], generation: 1 }]);
      const stored = await primaryOf(svc, STORED_LINES_SQL, {
        g: 1,
        issuers: [world.gate],
        currencies: [world.usd],
        holders: [world.pool],
      });
      expect(stored).toMatch(/Keys:\s+issuer\s+currency\s+holder/);
      expect(stored).toContain('(issuer, currency, holder) in 1-element set');
      const tokens = await primaryOf(svc, ISSUER_TOKENS_SQL, { g: 1, issuers: [world.gate, world.plain] });
      expect(tokens).toMatch(/Keys:\s+issuer/);
      expect(tokens).toContain('issuer in 2-element set');
    });

    // -----------------------------------------------------------------------------------------------------------------
    it('reads the line states, the stored lines and the tokens of 2,001 keys in chunks of a query parameter', async () => {
      const svc = await fresh();
      const COUNT = TOKENS_STATE_CHUNK + 1;
      const numbers = Array.from({ length: COUNT }, (_, n) => n);
      const HIGH = 'rBulkZHighAccountxxxxxxxxxxxxxxxxxx';
      const lowOf = (n: number): string => `rBulkLowAccount${String(n).padStart(5, '0')}xxxxxxxxxxxxxx`;
      const currencyOf = (n: number): string => `${n.toString(16).toUpperCase().padStart(8, '0')}${'AB'.repeat(16)}`;
      expect(currencyOf(0)).toHaveLength(40);
      expect(lowOf(0) < HIGH).toBe(true);

      // each line: the low account owes 5 and the high account's limit is 10, so that the low account's token has one holder
      await svc.insert(
        Table.TrustLineStates,
        numbers.map((n) => ({
          ...SAMPLE_ROWS[Table.TrustLineStates],
          account: lowOf(n),
          counterparty: HIGH,
          currency: currencyOf(n),
          ledger_index: 60,
          balance: '-5',
          limit: '0',
          limit_peer: '10',
          deleted: 0,
        })),
      );
      const lines = numbers.map((n) => ({ account: lowOf(n), counterparty: HIGH, currency: currencyOf(n) }));

      const spy = jest.spyOn(svc, 'query');
      let queried: Array<Record<string, unknown>> = [];
      let tokens: TokenKey[];
      let ofIssuers: TokenKey[];
      try {
        tokens = await applyLineStates(svc, { generation: 3, lines, atLedger: 70, version: '20' });
        // the tokens of 2,001 issuers
        await svc.insert(
          Table.Tokens,
          numbers.map((n) => ({
            ...SAMPLE_ROWS[Table.Tokens],
            generation: 3,
            issuer: lowOf(n),
            currency: currencyOf(n),
            version: '20',
          })),
        );
        ofIssuers = await tokensOfIssuers(
          svc,
          3,
          lines.map((line) => line.account),
        );
      } finally {
        // restoring clears the record of the calls
        queried = spy.mock.calls.map((call) => call[1] ?? {});
        spy.mockRestore();
      }

      const arrays = (name: string): number[] =>
        queried.flatMap((params) => (Array.isArray(params[name]) ? [(params[name] as unknown[]).length] : []));
      // the 2,001 lines are read in a chunk of 2,000 and one of 1; their 4,002 rows of token_lines are named 2,000, 2,000 and 2
      for (const name of ['accounts', 'counterparties']) {
        expect(arrays(name).filter((length) => length > 1)).toEqual([TOKENS_STATE_CHUNK]);
        expect(arrays(name).reduce((a, b) => a + b, 0)).toBe(COUNT);
      }
      expect(Math.max(...arrays('holders'))).toBe(TOKENS_STATE_CHUNK);
      expect(arrays('holders').reduce((a, b) => a + b, 0)).toBe(2 * COUNT);
      // the issuers of the tokens: 2,000 and 1, and both arrays of a line read are never over a chunk
      expect(Math.max(...arrays('issuers'))).toBe(TOKENS_STATE_CHUNK);
      for (const name of ['accounts', 'counterparties', 'currencies', 'issuers', 'holders']) {
        expect(Math.max(...arrays(name))).toBeLessThanOrEqual(TOKENS_STATE_CHUNK);
      }

      // every line made a row for the low account's token, and both orientations of every line are named
      expect(tokens).toHaveLength(2 * COUNT);
      expect(ofIssuers).toHaveLength(COUNT);
      const live = await liveLines(svc, 3);
      expect(live.size).toBe(COUNT);
      for (const n of [0, TOKENS_STATE_CHUNK - 1, TOKENS_STATE_CHUNK]) {
        expect(live.get(lineMapKey({ issuer: lowOf(n), currency: currencyOf(n) }, HIGH))).toMatchObject({
          balance: '5',
          limit: '10',
          ledger_index: 60,
        });
      }
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe('distinct holders, the toml sweep and dropping a generation', () => {
    /** A migrated database with the world's first batch built into generation 1 at its head. */
    async function builtWorld() {
      const svc = await fresh();
      const base = await seedTokensWorld(svc, new LedgerWriter(svc, CTX));
      await buildGeneration(svc, 1, base.head);
      return { svc, base };
    }

    const line = (
      generation: number,
      issuer: string,
      currency: string,
      holder: string,
      balance: string,
      version: string,
      deleted = 0,
    ): TokenLinesRow => ({
      ...SAMPLE_ROWS[Table.TokenLines],
      generation,
      issuer,
      currency,
      holder,
      balance,
      balance_f: Number(balance),
      ledger_index: 10,
      deleted,
      version,
    });

    /** The `read_rows` of the newest finished query of this database whose text holds `marker`. */
    async function readRowsOf(svc: ClickHouseService, marker: string): Promise<number> {
      const db = (await svc.queryOne<{ db: string }>('SELECT currentDatabase() AS db'))?.db ?? '';
      await svc.command('SYSTEM FLUSH LOGS');
      const [row] = await svc.query<{ read_rows: string }>(
        `SELECT read_rows FROM system.query_log
          WHERE type = 'QueryFinish' AND current_database = {db:String} AND position(query, {marker:String}) > 0
          ORDER BY event_time_microseconds DESC LIMIT 1`,
        { db, marker },
      );
      return Number(row.read_rows);
    }

    // -----------------------------------------------------------------------------------------------------------------
    describe('distinctHolders', () => {
      it('counts an account holding two tokens once and a zero line not at all', async () => {
        const svc = await fresh();
        await svc.insert(Table.TokenLines, [
          // alice holds three tokens of two issuers: one holder
          line(1, 'rIssuerOne', 'USD', 'rAlice', '5', '10'),
          line(1, 'rIssuerOne', 'EUR', 'rAlice', '7', '10'),
          line(1, 'rIssuerTwo', 'USD', 'rAlice', '1', '10'),
          // a line with a limit and no balance holds nothing
          line(1, 'rIssuerOne', 'USD', 'rZero', '0', '10'),
          // a line that was deleted: the tombstone still says what the row said, and it is the newest
          line(1, 'rIssuerOne', 'USD', 'rGone', '3', '10'),
          line(1, 'rIssuerOne', 'USD', 'rGone', '3', '20', 1),
          // the newest row of a line decides: 0 and then 9 counts, 4 and then 0 does not
          line(1, 'rIssuerOne', 'USD', 'rBack', '0', '10'),
          line(1, 'rIssuerOne', 'USD', 'rBack', '9', '20'),
          line(1, 'rIssuerOne', 'USD', 'rEmptied', '4', '10'),
          line(1, 'rIssuerOne', 'USD', 'rEmptied', '0', '20'),
          // a balance too small for a decimal to show still holds
          line(1, 'rIssuerOne', 'EUR', 'rTiny', '0.000000000000000000000000000000000001', '10'),
          // another generation is another set
          line(2, 'rIssuerOne', 'USD', 'rAlice', '5', '10'),
          line(2, 'rIssuerOne', 'USD', 'rOther', '8', '10'),
        ]);
        expect(await distinctHolders(svc, 1)).toBe(3);
        expect(await distinctHolders(svc, 2)).toBe(2);
        expect(await distinctHolders(svc, 7)).toBe(0);
      });

      it('counts the holders of the world as the brute force does', async () => {
        const { svc, base } = await builtWorld();
        const counting = [...(await bruteForceLines(svc, base.head)).values()].filter(
          ({ line: l }) => Number(l.balance) > 0,
        );
        const holders = new Set(counting.map(({ line: l }) => l.holder));
        // the AMM pool holds the USD of two issuers: it is one holder of two lines
        expect(holders.size).toBeLessThan(counting.length);
        expect(await distinctHolders(svc, 1)).toBe(holders.size);
      });

      it('reads the partition of the generation and no other', async () => {
        const svc = await fresh();
        await svc.insert(Table.TokenLines, [
          line(1, 'rIssuerOne', 'USD', 'rAlice', '5', '10'),
          line(1, 'rIssuerOne', 'USD', 'rBob', '5', '10'),
          line(1, 'rIssuerTwo', 'USD', 'rAlice', '5', '10'),
        ]);
        await svc.command(
          `INSERT INTO ${Table.TokenLines}
             (generation, issuer, currency, holder, balance, balance_f, \`limit\`, frozen, authorized, ledger_index, deleted, version)
           SELECT 2, concat('rIssuer', toString(number % 50)), 'USD', concat('rHolder', toString(number)), '1', 1, '10', 0, 0, 5, 0, 10
             FROM numbers(100000)`,
        );
        expect(await distinctHolders(svc, 1)).toBe(2);
        expect(await readRowsOf(svc, 'uniqExact(holder)')).toBe(3);
        expect(await distinctHolders(svc, 2)).toBe(100_000);
        expect(await readRowsOf(svc, 'uniqExact(holder)')).toBe(100_000);
      });
    });

    // -----------------------------------------------------------------------------------------------------------------
    describe('tomlSweep', () => {
      /** The sweep from `after` to the end, `limit` tokens a step: every step it took. */
      async function sweepToEnd(
        svc: ClickHouseService,
        o: { after?: TokenKey; limit?: number; version?: () => string } = {},
      ) {
        const steps: Array<{ rewritten: number; next: TokenKey | undefined }> = [];
        let after = o.after;
        do {
          const step = await tomlSweep(svc, {
            generation: 1,
            version: (o.version ?? nextVersion)(),
            profile: PROFILE,
            after,
            limit: o.limit,
          });
          steps.push(step);
          after = step.next;
        } while (after !== undefined);
        return steps;
      }

      const rewrittenIn = (steps: ReadonlyArray<{ rewritten: number }>): number =>
        steps.reduce((sum, step) => sum + step.rewritten, 0);

      /** A newer toml of `domain` with these entries. */
      const tomlOf = (domain: string, currencies: TomlCurrency[], checked: number): DomainTomlsRow =>
        okTomlRow({
          domain,
          tomlUrl: tomlUrlOf(domain, PROFILE),
          content: { modified: null, expires: null, accounts: [], currencies, validators: [], principals: [] },
          now: checked,
          recheckMs: 3_600_000,
        });

      /** A check that failed beyond its grace: nothing in effect (D4 writes these rows, so it is a literal here). */
      const failedToml = (domain: string, checked: number): DomainTomlsRow => ({
        domain,
        toml_url: tomlUrlOf(domain, PROFILE),
        status: 'failed',
        reason: 'http_status',
        status_code: 404,
        checked_at: checked,
        fetched_at: null,
        next_check_at: Math.ceil(checked + 86_400),
        failures: 9,
        modified: null,
        expires: null,
        accounts: [],
        currencies: [],
        validators: [],
        principals: [],
      });

      const entryOf = (code: string, issuer: string, fields: Record<string, unknown>): TomlCurrency => ({
        code,
        issuer,
        network: '',
        fields: JSON.stringify(fields),
      });

      it('rewrites a row whose domain or toml changed and no other', async () => {
        const { svc, base } = await builtWorld();
        const before = await liveTokens(svc, 1);
        expect(before.size).toBeGreaterThan(8);

        // nothing changed since the generation was built: nothing is written
        expect(rewrittenIn(await sweepToEnd(svc))).toBe(0);
        expect(await liveTokens(svc, 1)).toEqual(before);

        // plain moves to a domain whose toml was never stored; gate's toml names MYTOKEN anew and lists USD as it did
        await svc.insert(Table.AccountDomains, [
          {
            ...SAMPLE_ROWS[Table.AccountDomains],
            account: base.plain,
            ledger_index: base.head + 1,
            tx_index: 0,
            node_index: 0,
            version: String(BigInt(base.head + 1) << 32n),
            domain_hex: hexOf('Moved.Example'),
            deleted: 0,
          },
        ]);
        await svc.insert(Table.DomainTomls, [
          tomlOf(
            base.gateDomain,
            [
              entryOf('USD', base.gate, {
                name: 'Gateway Dollar',
                icon: 'https://gateway.example/usd.png',
                display_decimals: 2,
                ignored: 'not served',
              }),
              entryOf('MYTOKEN', base.gate, { name: 'My Token, renamed', symbol: 'MYT' }),
            ],
            1_700_000_100,
          ),
        ]);

        const version = nextVersion();
        const steps = await sweepToEnd(svc, { version: () => version });
        expect(rewrittenIn(steps)).toBe(2);

        const plain = tokenOf(base.plain, base.usd);
        const myToken = tokenOf(base.gate, base.myToken);
        const after = await liveTokens(svc, 1);
        expect([...after.keys()]).toEqual([...before.keys()]);
        // the counts, the supply and the issuer's settings are the row's own; the listing is the store's; the version is the sweep's
        expect(after.get(plain)).toEqual({
          ...before.get(plain),
          domain: 'moved.example',
          listed: 0,
          name: '',
          toml: '',
          version,
        });
        expect(after.get(myToken)).toEqual({
          ...before.get(myToken),
          name: 'My Token, renamed',
          toml: '{"name":"My Token, renamed","symbol":"MYT"}',
          version,
        });
        for (const [key, row] of after) {
          if (key !== plain && key !== myToken) expect(row).toEqual(before.get(key));
        }

        // swept again, the rows say what the store says
        expect(rewrittenIn(await sweepToEnd(svc))).toBe(0);
        expect(await liveTokens(svc, 1)).toEqual(after);
      });

      it('un-lists a token whose toml failed beyond its grace, and lists it again when the toml comes back', async () => {
        const { svc, base } = await builtWorld();
        const before = await liveTokens(svc, 1);
        const listed = [tokenOf(base.gate, base.usd), tokenOf(base.gate, base.myToken)];
        for (const key of listed) expect(before.get(key)).toMatchObject({ listed: 1, domain: base.gateDomain });

        // a newer check with nothing in effect
        await svc.insert(Table.DomainTomls, [failedToml(base.gateDomain, 1_700_000_100)]);
        const failedVersion = nextVersion();
        expect(rewrittenIn(await sweepToEnd(svc, { version: () => failedVersion }))).toBe(2);
        const unlisted = await liveTokens(svc, 1);
        for (const key of listed) {
          expect(unlisted.get(key)).toEqual({
            ...before.get(key),
            domain: base.gateDomain,
            listed: 0,
            name: '',
            toml: '',
            version: failedVersion,
          });
        }
        // gate's BTH was never listed, and was not written
        expect(unlisted.get(tokenOf(base.gate, base.both))).toEqual(before.get(tokenOf(base.gate, base.both)));

        // the toml is fetched again, as it was
        await svc.insert(Table.DomainTomls, [
          tomlOf(
            base.gateDomain,
            [
              entryOf('USD', base.gate, {
                name: 'Gateway Dollar',
                icon: 'https://gateway.example/usd.png',
                display_decimals: 2,
              }),
              entryOf('MYTOKEN', base.gate, { name: 'My Token', symbol: 'MYT' }),
            ],
            1_700_000_200,
          ),
        ]);
        expect(rewrittenIn(await sweepToEnd(svc))).toBe(2);
        const relisted = await liveTokens(svc, 1);
        for (const key of listed) {
          expect(relisted.get(key)).toMatchObject({
            listed: 1,
            name: before.get(key)?.name,
            toml: before.get(key)?.toml,
          });
        }
      });

      it('goes on from a cursor in steps of limit tokens and ends with no cursor', async () => {
        const { svc, base } = await builtWorld();
        // a token whose newest row is a deletion is not live whatever its older row says, and is not rewritten
        await svc.insert(Table.Tokens, [
          {
            ...SAMPLE_ROWS[Table.Tokens],
            generation: 1,
            issuer: base.plain,
            currency: 'DEL',
            domain: '',
            listed: 0,
            name: '',
            toml: '',
            deleted: 0,
            version: nextVersion(),
          },
          {
            ...SAMPLE_ROWS[Table.Tokens],
            generation: 1,
            issuer: base.plain,
            currency: 'DEL',
            domain: '',
            listed: 0,
            name: '',
            toml: '',
            deleted: 1,
            version: nextVersion(),
          },
        ]);
        const keys = (
          await svc.query<TokenKey>(
            `SELECT DISTINCT issuer, currency FROM ${Table.Tokens} WHERE generation = 1 ORDER BY issuer, currency`,
          )
        ).map(({ issuer, currency }) => ({ issuer, currency }));
        expect(keys.length).toBeGreaterThan(9);
        const newestOfDel = async () =>
          (
            await svc.query<{ deleted: number }>(
              `SELECT deleted FROM ${Table.Tokens} WHERE generation = 1 AND issuer = {issuer:String} AND currency = 'DEL'
                ORDER BY version DESC LIMIT 1`,
              { issuer: base.plain },
            )
          )[0].deleted;
        await svc.insert(Table.DomainTomls, [failedToml(base.gateDomain, 1_700_000_100)]);

        // three a step: a step reads at most three tokens, its cursor is the last it read, and the one after the last ends it
        const steps = await sweepToEnd(svc, { limit: 3 });
        expect(steps).toHaveLength(Math.ceil(keys.length / 3));
        steps.forEach((step, k) => {
          expect(step.next).toEqual((k + 1) * 3 < keys.length ? keys[(k + 1) * 3 - 1] : undefined);
        });
        expect(rewrittenIn(steps)).toBe(2);
        expect(Number(await newestOfDel())).toBe(1);

        // the number of steps is the same when a step takes exactly the rest, and one step takes them all
        expect((await sweepToEnd(svc, { limit: keys.length })).map((step) => step.next)).toEqual([undefined]);
        expect(await sweepToEnd(svc, { limit: keys.length - 1 })).toHaveLength(2);

        // a step starts after its cursor: what is at or before it is not looked at
        await svc.insert(Table.DomainTomls, [
          tomlOf(
            base.gateDomain,
            [
              entryOf('USD', base.gate, { name: 'Gateway Dollar' }),
              entryOf('MYTOKEN', base.gate, { name: 'My Token' }),
            ],
            1_700_000_200,
          ),
        ]);
        const last = keys[keys.length - 1];
        const gateKeys = keys.filter((key) => key.issuer === base.gate);
        expect(gateKeys.length).toBeGreaterThan(1);
        const pastGate = await tomlSweep(svc, {
          generation: 1,
          version: nextVersion(),
          profile: PROFILE,
          after: gateKeys[gateKeys.length - 1],
          limit: keys.length,
        });
        expect(pastGate.rewritten).toBe(0);
        const atTheEnd = await tomlSweep(svc, { generation: 1, version: nextVersion(), profile: PROFILE, after: last });
        expect(atTheEnd).toEqual({ rewritten: 0, next: undefined });
        // and the rest, from the start, finds the two
        expect(rewrittenIn(await sweepToEnd(svc, { limit: 4 }))).toBe(2);
      });

      it('reads a step of tokens, not every token after the cursor', async () => {
        // three parts that each hold the same 100,000 tokens, merges stopped so that they stay
        const svc = await fresh();
        const db = (await svc.queryOne<{ db: string }>('SELECT currentDatabase() AS db'))?.db ?? '';
        await svc.command(`SYSTEM STOP MERGES ${db}.${Table.Tokens}`);
        const PARTS = 3;
        for (let part = 0; part < PARTS; part++) {
          await svc.command(
            `INSERT INTO ${Table.Tokens}
               (generation, issuer, currency, code, holders, trust_lines, supply, supply_f, last_ledger, issuer_ledger, issuer_flags,
                transfer_rate, domain, listed, name, toml, deleted, version)
             SELECT 1, concat('rIssuer', leftPad(toString(number), 7, '0')), 'USD', 'USD', 1, 1, '1', 1, 5, 4, 0, 0, '', 0, '', '', 0,
                    {version:UInt64}
               FROM numbers(100000)`,
            { version: 10 + part },
          );
        }
        const step = await tomlSweep(svc, {
          generation: 1,
          version: '100',
          profile: PROFILE,
          after: { issuer: 'rIssuer0030000', currency: 'USD' },
          limit: 5,
        });
        // no issuer has a domain, so every token says what the sweep finds
        expect(step).toEqual({ rewritten: 0, next: { issuer: 'rIssuer0030005', currency: 'USD' } });
        const rows = await readRowsOf(svc, 'top_domain');
        // 210,000 rows lie after the cursor: a step of 5 reads a granule or a few of each part (8,192 rows)
        expect(rows).toBeLessThan(PARTS * 4 * 8_192);
      });

      it('writes nothing once the signal is aborted', async () => {
        const { svc, base } = await builtWorld();
        await svc.insert(Table.DomainTomls, [failedToml(base.gateDomain, 1_700_000_100)]);
        const before = await liveTokens(svc, 1);
        const controller = new AbortController();
        controller.abort();
        await expect(
          tomlSweep(svc, { generation: 1, version: nextVersion(), profile: PROFILE }, controller.signal),
        ).rejects.toBeInstanceOf(TokensAborted);
        expect(await liveTokens(svc, 1)).toEqual(before);
        // the same step with the signal alive would have written
        expect(rewrittenIn(await sweepToEnd(svc))).toBe(2);
      });
    });

    // -----------------------------------------------------------------------------------------------------------------
    describe('dropTokenGeneration', () => {
      const generationsOf = async (svc: ClickHouseService, table: Table): Promise<number[]> =>
        (await svc.query<{ generation: number }>(`SELECT DISTINCT generation FROM ${table} ORDER BY generation`)).map(
          (r) => Number(r.generation),
        );

      it('drops only that generation of both tables', async () => {
        const svc = await fresh();
        for (const generation of [1, 2, 3]) {
          await svc.insert(Table.TokenLines, [{ ...SAMPLE_ROWS[Table.TokenLines], generation }]);
          await svc.insert(Table.Tokens, [{ ...SAMPLE_ROWS[Table.Tokens], generation }]);
          await svc.insert(Table.TokenGenerations, [{ ...SAMPLE_ROWS[Table.TokenGenerations], generation }]);
        }
        await dropTokenGeneration(svc, 2);
        expect(await generationsOf(svc, Table.TokenLines)).toEqual([1, 3]);
        expect(await generationsOf(svc, Table.Tokens)).toEqual([1, 3]);
        // the generation's own state is not a partition of either, and stays
        expect(await generationsOf(svc, Table.TokenGenerations)).toEqual([1, 2, 3]);

        // a partition that is not there is nothing to drop: the job may run it again after a restart
        await dropTokenGeneration(svc, 2);
        await dropTokenGeneration(svc, 99);
        expect(await generationsOf(svc, Table.TokenLines)).toEqual([1, 3]);
        await dropTokenGeneration(svc, 1);
        await dropTokenGeneration(svc, 3);
        expect(await generationsOf(svc, Table.TokenLines)).toEqual([]);
        expect(await generationsOf(svc, Table.Tokens)).toEqual([]);
      });

      it('refuses a generation that is not a UInt32', async () => {
        const svc = await fresh();
        const spy = jest.spyOn(svc, 'command');
        try {
          for (const bad of [-1, 1.5, 4_294_967_296, Number.NaN, Number.POSITIVE_INFINITY, 1e21]) {
            await expect(dropTokenGeneration(svc, bad)).rejects.toThrow(RangeError);
          }
          // nothing was sent
          expect(spy).not.toHaveBeenCalled();
          // the ends of the range are generations
          await dropTokenGeneration(svc, 0);
          await dropTokenGeneration(svc, 4_294_967_295);
          expect(spy).toHaveBeenCalledTimes(4);
        } finally {
          spy.mockRestore();
        }
      });
    });
  });
});
