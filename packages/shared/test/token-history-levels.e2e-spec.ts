import BigNumber from 'bignumber.js';
import { TokenKey } from '../src/aggregate/token-rules';
import { ClickHouseService } from '../src/clickhouse/clickhouse.service';
import { runMigrations } from '../src/clickhouse/migrate';
import { LedgersRow, TokenHolderChangesRow } from '../src/clickhouse/rows';
import { Table } from '../src/clickhouse/tables';
import { seededRandom } from '../src/test-utils/token-history-cases';
import {
  buildSmallTokenLevels,
  buildTokenLevels,
  nextLevelsSlice,
  nextLevelTokens,
} from '../src/token-history/build/levels';
import { checkpointLedgers, LedgerTotals } from '../src/token-history/checkpoint-rule';
import { ChangeAmounts, flowsOfTransaction } from '../src/token-history/flows';
import { holdersAt, totalsAt } from '../src/token-history/holders-at';
import { writeHourSets } from '../src/token-history/hour-sets';
import { orderKeyOf } from '../src/token-history/order-key';
import { startClickHouse, StartedClickHouse } from './clickhouse-container';
import { SAMPLE_ROWS } from './sample-rows';

/** Ledgers close every 10 minutes, so an hour holds six; the first closes at T0. */
const T0 = 1_750_000_800;
const closeOf = (ledger: number): number => T0 + (ledger - 1) * 600;
const LEDGERS = 300;
const FLOOR = 5;

/** The tokens of the generated change log: two ordinary ones, and one whose amounts the decimal cannot hold. */
const TOKENS: TokenKey[] = [
  { issuer: 'rIssuerA', currency: 'USD' },
  { issuer: 'rIssuerB', currency: 'EUR' },
  { issuer: 'rIssuerB', currency: 'HUG' },
];

/**
 * A change log of `TOKENS`, consistent holder by holder: each change's before is the holder's amount after its previous change. Some
 * transactions move an amount between two holders (a transfer, with a fee now and then), some are clawbacks, and a holder's first
 * change is now and then of an unknown before-state.
 */
function generatedChangeLog(g: number): TokenHolderChangesRow[] {
  const rows: TokenHolderChangesRow[] = [];
  TOKENS.forEach((token, t) => {
    const rnd = seededRandom(100 + t);
    const huge = token.currency === 'HUG';
    const amount = (): string => {
      if (rnd() < 0.15) return '0';
      if (huge && rnd() < 0.3) return rnd() < 0.5 ? new BigNumber('1e40').toFixed() : new BigNumber('1e-81').toFixed();
      return new BigNumber(Math.floor(rnd() * 1e6) + 1).shiftedBy(-Math.floor(rnd() * 4)).toFixed();
    };
    const state = new Map<string, { amount: string; counted: boolean }>();
    for (let ledger = 1; ledger <= LEDGERS; ledger++) {
      if (rnd() < 0.3) continue;
      const txs = 1 + Math.floor(rnd() * 3);
      for (let tx = 0; tx < txs; tx++) {
        const clawback = rnd() < 0.1 ? 1 : 0;
        const holders = 1 + Math.floor(rnd() * 3);
        for (let node = 0; node < holders; node++) {
          const holder = `rHolder${Math.floor(rnd() * 12)}`;
          if (
            rows.some(
              (r) =>
                r.issuer === token.issuer &&
                r.currency === token.currency &&
                r.ledger_index === ledger &&
                r.tx_index === tx &&
                r.holder === holder,
            )
          )
            continue;
          const was = state.get(holder);
          const counted = rnd() > 0.1;
          const after = counted ? amount() : '0';
          if (!counted && !was?.counted) continue;
          const key = orderKeyOf(after, 'issued');
          rows.push({
            generation: g,
            issuer: token.issuer,
            currency: token.currency,
            ledger_index: ledger,
            tx_index: tx,
            node_index: node,
            holder,
            close_time: closeOf(ledger),
            clawback,
            amount_before: was?.amount ?? '0',
            amount_after: after,
            counted_before: was?.counted ? 1 : 0,
            counted_after: counted ? 1 : 0,
            before_known: was === undefined && rnd() < 0.3 ? 0 : 1,
            limit: '1000',
            frozen: 0,
            authorized: 0,
            escrowed: '0',
            order_exp: key.exp,
            order_mant: key.mant.toString(),
          });
          state.set(holder, { amount: after, counted });
        }
      }
    }
  });
  return rows;
}

interface HourRead {
  hour: number;
  supply: string;
  holders: string;
  trust_lines: string;
  issued: string;
  redeemed: string;
  clawed_back: string;
  transferred: string;
  transfers: number;
  changes: number;
  unknown_before: number;
  first_ledger: number;
  last_ledger: number;
  final: number;
  version: string;
}

const HOURS_SQL = `SELECT toUnixTimestamp(hour) AS hour, supply, toString(holders) AS holders, toString(trust_lines) AS trust_lines,
       issued, redeemed, clawed_back, transferred, transfers, changes, unknown_before, first_ledger, last_ledger, final,
       toString(version) AS version
  FROM ${Table.TokenHourly}
 WHERE generation = {g:UInt32} AND issuer = {issuer:String} AND currency = {currency:String}
 ORDER BY hour, version DESC
 LIMIT 1 BY hour`;

describe('the levels phase of the token history build (e2e)', () => {
  let container: StartedClickHouse;
  let ch: ClickHouseService;
  const UP_TO = LEDGERS - 3;

  const hoursOf = (g: number, token: TokenKey) => ch.query<HourRead>(HOURS_SQL, { g, ...token });
  const without = <T extends { version: string }>(rows: T[]) => rows.map(({ version: _v, ...r }) => r);
  const tablesOf = async (g: number) => ({
    hours: await ch.query(
      `SELECT issuer, currency, toUnixTimestamp(hour) AS hour, supply, holders, trust_lines, issued, redeemed, clawed_back, transferred,
              transfers, changes, unknown_before, first_ledger, last_ledger, final
         FROM ${Table.TokenHourly} WHERE generation = {g:UInt32}
        ORDER BY issuer, currency, hour, version DESC LIMIT 1 BY issuer, currency, hour`,
      { g },
    ),
    heads: await ch.query(
      `SELECT issuer, currency, checkpoint_ledger, supply, holders, trust_lines, changes_since, first_ledger
         FROM ${Table.TokenCheckpointHeads} WHERE generation = {g:UInt32}
        ORDER BY issuer, currency, checkpoint_ledger LIMIT 1 BY issuer, currency, checkpoint_ledger`,
      { g },
    ),
    rows: await ch.query(
      `SELECT issuer, currency, checkpoint_ledger, holder, amount, escrowed, \`limit\`, frozen, authorized, order_exp,
              toString(order_mant) AS order_mant, first_ledger, last_ledger
         FROM ${Table.TokenCheckpoints} WHERE generation = {g:UInt32}
        ORDER BY issuer, currency, checkpoint_ledger, holder LIMIT 1 BY issuer, currency, checkpoint_ledger, holder`,
      { g },
    ),
  });

  /** Builds the levels of every token of generation `g`, in key order, `n` tokens at a time. */
  async function buildAll(g: number, opts: { slice?: number } = {}): Promise<number> {
    let after: TokenKey | undefined;
    let built = 0;
    for (;;) {
      const tokens = await nextLevelTokens(ch, g, after, 2);
      if (tokens.length === 0) return built;
      for (const token of tokens) {
        await buildTokenLevels(ch, g, token, UP_TO, { floor: FLOOR, version: 1_000 + g, ...opts });
        built++;
      }
      after = tokens[tokens.length - 1];
    }
  }

  beforeAll(async () => {
    container = await startClickHouse();
    const config = { ...container.config, database: 'token_history_levels' };
    await runMigrations({ config, log: () => undefined });
    ch = new ClickHouseService(config);
    const ledgers: LedgersRow[] = Array.from({ length: LEDGERS }, (_, i) => ({
      ...SAMPLE_ROWS[Table.Ledgers],
      ledger_index: i + 1,
      ledger_hash: String(i + 1).padStart(64, 'D'),
      close_time: closeOf(i + 1),
    }));
    await ch.insert(Table.Ledgers, ledgers);
    for (const g of [1, 2, 3, 4, 5]) await ch.insert(Table.TokenHolderChanges, generatedChangeLog(g));
    expect(await buildAll(1)).toBe(TOKENS.length);
    await buildAll(2, { slice: 3 });
  }, 300_000);

  afterAll(async () => {
    await ch?.close();
    await container?.container.stop();
  });

  it('lists the tokens of a generation in key order', async () => {
    const all = await nextLevelTokens(ch, 1, undefined, 10);
    expect(all).toEqual([...TOKENS].sort((a, b) => (a.issuer + a.currency < b.issuer + b.currency ? -1 : 1)));
    expect(await nextLevelTokens(ch, 1, all[1], 10)).toEqual([all[2]]);
  });

  it("every hour row's levels equal totalsAt at the hour's last ledger", async () => {
    for (const token of TOKENS) {
      const hours = await hoursOf(1, token);
      expect(hours.length).toBeGreaterThan(20);
      for (const h of hours) {
        // a final hour ends at its last ledger; the last hour, not final, at the ledger the levels are made up to
        const lastOfHour = Math.floor((h.hour + 3_600 - 1 - T0) / 600) + 1;
        const end = h.final === 1 ? lastOfHour : UP_TO;
        const totals = await totalsAt(ch, 1, token, Math.min(end, UP_TO));
        expect({
          token,
          hour: h.hour,
          supply: h.supply,
          holders: Number(h.holders),
          trust_lines: Number(h.trust_lines),
        }).toEqual({
          token,
          hour: h.hour,
          supply: totals.supply,
          holders: totals.holders,
          trust_lines: totals.trust_lines,
        });
      }
      expect(hours.filter((h) => h.final === 0).map((h) => h.hour)).toEqual([hours[hours.length - 1].hour]);
      expect(Math.max(...hours.map((h) => h.last_ledger))).toBeLessThanOrEqual(UP_TO);
    }
  });

  it("every hour row's flows satisfy the flow identity against the previous row", async () => {
    const log = generatedChangeLog(1);
    for (const token of TOKENS) {
      const hours = await hoursOf(1, token);
      let previous = new BigNumber(0);
      for (const h of hours) {
        // the flows of the hour, folded transaction by transaction in TypeScript
        const mine = log.filter(
          (c) =>
            c.issuer === token.issuer &&
            c.currency === token.currency &&
            c.close_time >= h.hour &&
            c.close_time < h.hour + 3_600 &&
            c.ledger_index <= UP_TO,
        );
        const txs = new Map<string, { changes: ChangeAmounts[]; clawback: boolean }>();
        for (const c of mine) {
          const key = `${c.ledger_index}:${c.tx_index}`;
          const tx = txs.get(key) ?? { changes: [], clawback: c.clawback === 1 };
          tx.changes.push({ before: c.amount_before, after: c.amount_after, beforeKnown: c.before_known === 1 });
          txs.set(key, tx);
        }
        let issued = new BigNumber(0);
        let redeemed = new BigNumber(0);
        let clawed = new BigNumber(0);
        let transferred = new BigNumber(0);
        let transfers = 0;
        for (const tx of txs.values()) {
          const f = flowsOfTransaction(tx.changes, tx.clawback);
          issued = issued.plus(f.issued);
          redeemed = redeemed.plus(f.redeemed);
          clawed = clawed.plus(f.clawed_back);
          transferred = transferred.plus(f.transferred);
          transfers += f.transfers;
        }
        const unknownNet = mine
          .filter((c) => c.before_known === 0)
          .reduce((s, c) => s.plus(c.amount_after).minus(c.amount_before), new BigNumber(0));
        expect({
          hour: h.hour,
          issued: h.issued,
          redeemed: h.redeemed,
          clawed_back: h.clawed_back,
          transferred: h.transferred,
          transfers: h.transfers,
          changes: h.changes,
          unknown_before: h.unknown_before,
        }).toEqual({
          hour: h.hour,
          issued: issued.toFixed(),
          redeemed: redeemed.toFixed(),
          clawed_back: clawed.toFixed(),
          transferred: transferred.toFixed(),
          transfers,
          changes: mine.length,
          unknown_before: mine.filter((c) => c.before_known === 0).length,
        });
        // supply now − supply before = issued − redeemed − clawed back, and the changes of an unknown before-state
        expect(new BigNumber(h.supply).minus(previous).toFixed()).toBe(
          issued.minus(redeemed).minus(clawed).plus(unknownNet).toFixed(),
        );
        previous = new BigNumber(h.supply);
      }
    }
  });

  it('checkpoints fall where checkpointLedgers says, and each head is written after its rows', async () => {
    let checkpoints = 0;
    for (const token of TOKENS) {
      const perLedger = await ch.query<{ ledger_index: number; changes: string; lines: string }>(
        `SELECT ledger_index, toString(count()) AS changes,
                toString(sum(sum(toInt64(counted_after) - toInt64(counted_before))) OVER (ORDER BY ledger_index)) AS lines
           FROM ${Table.TokenHolderChanges}
          WHERE generation = 1 AND issuer = {issuer:String} AND currency = {currency:String} AND ledger_index <= {upTo:UInt32}
          GROUP BY ledger_index ORDER BY ledger_index`,
        { ...token, upTo: UP_TO },
      );
      const totals: LedgerTotals[] = perLedger.map((r) => ({
        ledger_index: r.ledger_index,
        changes: Number(r.changes),
        trust_lines_after: Number(r.lines),
      }));
      const want = checkpointLedgers(totals, 0, FLOOR);
      const heads = await ch.query<{ checkpoint_ledger: number; supply: string; holders: string; trust_lines: string }>(
        `SELECT checkpoint_ledger, supply, toString(holders) AS holders, toString(trust_lines) AS trust_lines
           FROM ${Table.TokenCheckpointHeads}
          WHERE generation = 1 AND issuer = {issuer:String} AND currency = {currency:String}
          ORDER BY checkpoint_ledger`,
        { ...token },
      );
      expect(heads.map((h) => h.checkpoint_ledger)).toEqual(want);
      for (const h of heads) {
        const rows = await ch.query<{ amount: string }>(
          `SELECT amount FROM ${Table.TokenCheckpoints}
            WHERE generation = 1 AND issuer = {issuer:String} AND currency = {currency:String} AND checkpoint_ledger = {cp:UInt32}`,
          { ...token, cp: h.checkpoint_ledger },
        );
        const totals = await totalsAt(ch, 1, token, h.checkpoint_ledger);
        expect(rows.length).toBe(Number(h.trust_lines));
        expect(rows.reduce((s, r) => s.plus(r.amount), new BigNumber(0)).toFixed()).toBe(h.supply);
        expect({ supply: h.supply, holders: Number(h.holders), trust_lines: Number(h.trust_lines) }).toEqual({
          supply: totals.supply,
          holders: totals.holders,
          trust_lines: totals.trust_lines,
        });
      }
      checkpoints += heads.length;
    }
    expect(checkpoints).toBeGreaterThan(10);
  });

  it('holders read through the checkpoints equal the holders folded from the start', async () => {
    // generation 3 has the same changes and no checkpoint at all
    for (const token of TOKENS) {
      for (const n of [50, 51, 150, UP_TO]) {
        const sort = (a: { holder: string }, b: { holder: string }) => (a.holder < b.holder ? -1 : 1);
        expect((await holdersAt(ch, 1, token, n)).sort(sort)).toEqual((await holdersAt(ch, 3, token, n)).sort(sort));
      }
    }
  });

  it('a slice holds at most `slice` changes, or one hour, and the slices walk every ledger once', async () => {
    for (const token of TOKENS) {
      const all = (
        await ch.query<{ l: number }>(
          `SELECT DISTINCT ledger_index AS l FROM ${Table.TokenHolderChanges}
            WHERE generation = 1 AND issuer = {issuer:String} AND currency = {currency:String} AND ledger_index <= {up:UInt32}
            ORDER BY l`,
          { ...token, up: UP_TO },
        )
      ).map((r) => Number(r.l));
      const seen: number[] = [];
      let after = 0;
      for (let i = 0; i < 1_000; i++) {
        const read = await nextLevelsSlice(ch, 1, token, after, UP_TO, 7);
        if (read.length === 0) break;
        const changes = read.reduce((s, r) => s + Number(r.changes), 0);
        expect({ token, after, bounded: changes <= 7 || new Set(read.map((r) => r.hour)).size === 1 }).toEqual({
          token,
          after,
          bounded: true,
        });
        seen.push(...read.map((r) => Number(r.ledger_index)));
        after = Number(read[read.length - 1].ledger_index);
      }
      expect({ token, seen }).toEqual({ token, seen: all });
    }
  });

  it('a token larger than a slice is built in slices and gives the same rows', async () => {
    const one = await tablesOf(1);
    const sliced = await tablesOf(2);
    expect(sliced).toEqual(one);
    expect(one.hours.length).toBeGreaterThan(60);
  });

  it('running the phase again writes nothing new', async () => {
    const versions = async () =>
      ch.queryOne<{ hours: string; heads: string; rows: string; newest: string }>(
        `SELECT (SELECT toString(count()) FROM ${Table.TokenHourly} WHERE generation = 1) AS hours,
                (SELECT toString(count()) FROM ${Table.TokenCheckpointHeads} WHERE generation = 1) AS heads,
                (SELECT toString(count()) FROM ${Table.TokenCheckpoints} WHERE generation = 1) AS rows,
                (SELECT toString(max(version)) FROM ${Table.TokenHourly} WHERE generation = 1) AS newest`,
      );
    const before = await versions();
    const tables = await tablesOf(1);
    await buildAll(1);
    expect(await versions()).toEqual(before);
    expect(await tablesOf(1)).toEqual(tables);
  });

  it('a batch of small tokens is built in one statement and gives the rows of one token at a time', async () => {
    // a floor above every token's changes: no token can have a checkpoint, so each is small unless an amount does not fit
    const opts = { floor: 1_000_000, version: 7 };
    const all = await nextLevelTokens(ch, 4, undefined, 10);
    for (const token of all) await buildTokenLevels(ch, 4, token, UP_TO, opts);
    const { big, hours } = await buildSmallTokenLevels(ch, 5, all, UP_TO, opts);
    // HUG has amounts the decimal cannot hold: it is left to buildTokenLevels
    expect(big).toEqual([TOKENS[2]]);
    expect(hours).toBeGreaterThan(40);
    for (const token of big) await buildTokenLevels(ch, 5, token, UP_TO, opts);
    expect(await tablesOf(5)).toEqual(await tablesOf(4));
    expect((await tablesOf(5)).heads).toEqual([]);
    // a token with as many changes as the floor is big too
    const small = await buildSmallTokenLevels(ch, 5, all, UP_TO, { floor: 10, version: 7 });
    expect(small.big).toEqual(all);
    expect(small.hours).toBe(0);
  });

  it('writeHourSets rewrites an hour whole, as the build wrote it', async () => {
    const token = TOKENS[0];
    const hours = await hoursOf(1, token);
    const target = hours[10];
    await writeHourSets(ch, 1, token, [new Date(target.hour * 1000)], UP_TO);
    const again = await hoursOf(1, token);
    const rewritten = again.find((h) => h.hour === target.hour)!;
    expect(BigInt(rewritten.version)).toBeGreaterThan(BigInt(target.version));
    expect(without([rewritten])).toEqual(without([target]));
  });
});
