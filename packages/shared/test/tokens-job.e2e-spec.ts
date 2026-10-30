import { TokenKey } from '../src/aggregate/token-rules';
import {
  buildingGenerationOf,
  issuerDomains,
  liveGenerationOf,
  nextPassAccounts,
  PASS_LINES_SELECT,
  passTokens,
  readTokenGenerations,
  recomputeTokens,
  stateCoverageStart,
  TOKENS_PASS_ACCOUNTS,
  TOKENS_STATE_CHUNK,
  TOKENS_TOML_DOMAINS_CHUNK,
  TokensAborted,
  tokensVersionFloor,
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
import { okTomlRow, tomlUrlOf } from '../src/tomls/toml-store';
import { startClickHouse, StartedClickHouse } from './clickhouse-container';
import { SAMPLE_ROWS } from './sample-rows';
import {
  bruteForceLines,
  bruteForceTokens,
  lineMapKey,
  seedTokensWorld,
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
    const hexOf = (text: string): string => Buffer.from(text).toString('hex').toUpperCase();

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
});
