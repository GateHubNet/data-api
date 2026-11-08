import {
  ClickHouseService,
  flowsOfTransaction,
  getNetworkProfile,
  LedgerWriter,
  mptIssuanceId,
  parseContextFor,
  promoteIfCaughtUp,
  readTokenHistoryStates,
  runTokenHistoryBuild,
  Table,
} from '@gatehub/data-api-shared';
import BigNumber from 'bignumber.js';
import {
  bruteForceLines,
  bruteForceTokens,
  seedTokenHistoryWorld,
  TokenHistoryWorld,
  tokenMapKey,
} from '../../../packages/shared/test/tokens-world';
import { FLOWS_SCHEMA, ISSUER_TOKENS_SCHEMA, SUMMARY_SCHEMA, SUPPLY_SCHEMA } from '../src/token-history/schemas';
import {
  FLOWS_KEYS,
  ISSUER_TOKEN_KEYS,
  SUMMARY_KEYS,
  SUMMARY_WINDOW_KEYS,
  SUPPLY_ROW_KEYS,
} from '../src/token-history/token-history-objects';
import { ApiClient, Harness, NO_RATE_LIMIT, startHarness } from './harness';
import { expectSchema } from './support/ajv';
import { expectNoMptRead } from './support/mpt-world';

/**
 * The token history's read routes (issuer analytics, spec 5) on a real ClickHouse: the token history world of the shared suites
 * (`seedTokenHistoryWorld`), an MPT of its gateway and a token of extreme amounts, built by `runTokenHistoryBuild` and promoted, as
 * the operator's command and the worker would.
 */

const CTX = parseContextFor(getNetworkProfile('xrpl'));
const SMALL = { passAccounts: 3, levelTokens: 2, floor: 5 } as const;
const log = { info: () => undefined };
const HOUR = 3_600;
const HUGE = new BigNumber('9.999999999999999e80').toFixed();
const TINY = new BigNumber('1e-81').toFixed();

type Obj = Record<string, unknown>;

/** `entry` has the keys of `order` it has, in that order. */
function expectKeysInOrder(entry: object, order: readonly string[]): void {
  const keys = Object.keys(entry);
  expect(keys).toEqual(order.filter((k) => keys.includes(k)));
}

/** The close time (unix seconds) of every stored ledger. */
async function closeTimes(ch: ClickHouseService): Promise<Map<number, number>> {
  const rows = await ch.query<{ ledger_index: number; close_time: number }>(
    `SELECT ledger_index, toUnixTimestamp(close_time) AS close_time FROM ${Table.Ledgers} ORDER BY ledger_index`,
  );
  return new Map(rows.map((r) => [Number(r.ledger_index), Number(r.close_time)]));
}

/**
 * A token of gate, `XTR`, with two lines: one of 9.999999999999999e80 and one of 1e-81. Its rows are copies of the two sides of the
 * newest change of two of gate's USD lines with a positive balance, under the new currency, the balance's sign kept.
 */
async function seedExtremeToken(ch: ClickHouseService, world: TokenHistoryWorld): Promise<void> {
  const usd = tokenMapKey({ issuer: world.gate, currency: world.usd });
  const holders = [...(await bruteForceLines(ch as never, world.head)).entries()]
    .filter(([k, v]) => k.startsWith(`${usd} `) && new BigNumber(v.line.balance).gt(0))
    .map(([k]) => k.slice(usd.length + 1))
    .slice(0, 2);
  expect(holders).toHaveLength(2);
  for (const [i, holder] of holders.entries()) {
    const rows = await ch.query<Obj>(
      `SELECT * EXCEPT (close_time), toUnixTimestamp(close_time) AS close_time FROM ${Table.TrustLineStates}
        WHERE currency = {usd:String}
          AND ((account = {gate:String} AND counterparty = {holder:String}) OR (account = {holder:String} AND counterparty = {gate:String}))
          AND ledger_index <= {head:UInt32}
        ORDER BY ledger_index DESC, tx_index DESC, node_index DESC
        LIMIT 2`,
      { usd: world.usd, gate: world.gate, holder, head: world.head },
    );
    const amount = i === 0 ? HUGE : TINY;
    await ch.insert(
      Table.TrustLineStates,
      rows.map((r) => ({ ...r, currency: 'XTR', balance: String(r.balance).startsWith('-') ? `-${amount}` : amount })),
    );
  }
}

/** Three holders of an MPT of gate, with changes in the world's ledgers, at their ledgers' close times. */
async function seedGateMpt(ch: ClickHouseService, world: TokenHistoryWorld): Promise<string> {
  const id = mptIssuanceId(1, world.gate);
  const close = await closeTimes(ch);
  const row = (holder: string, ledger: number, amount: string) => ({
    holder,
    mpt_issuance_id: id,
    ledger_index: ledger,
    tx_index: 0,
    node_index: 0,
    tx_hash: `mpt-${holder}-${ledger}`,
    tx_type: 'Payment',
    close_time: close.get(ledger)!,
    amount,
    escrowed_amount: '0',
    flags: 0,
    deleted: 0,
  });
  await ch.insert(Table.MptHolderStates, [
    row('rMptHolderA00000000000000000000000', world.first, '0'),
    row('rMptHolderA00000000000000000000000', world.first + 2, '100'),
    row('rMptHolderB00000000000000000000000', world.first + 1, '0'),
    row('rMptHolderB00000000000000000000000', world.first + 3, '7'),
  ]);
  return id;
}

/** The flows of every transaction of a token in `[from, to]`, from its change log, by `flowsOfTransaction`, summed. */
async function bruteFlows(
  ch: ClickHouseService,
  token: { issuer: string; currency: string },
  from: number,
  to: number,
) {
  const rows = await ch.query<{
    ledger_index: number;
    tx_index: number;
    clawback: number;
    amount_before: string;
    amount_after: string;
    before_known: number;
  }>(
    `SELECT ledger_index, tx_index, clawback, amount_before, amount_after, before_known FROM ${Table.TokenHolderChanges}
      WHERE generation = 1 AND issuer = {issuer:String} AND currency = {currency:String}
        AND ledger_index >= {from:UInt32} AND ledger_index <= {to:UInt32}
      ORDER BY ledger_index, tx_index, node_index, holder
      LIMIT 1 BY ledger_index, tx_index, node_index, holder`,
    { ...token, from, to },
  );
  const byTx = new Map<string, typeof rows>();
  for (const r of rows)
    byTx.set(`${r.ledger_index}:${r.tx_index}`, [...(byTx.get(`${r.ledger_index}:${r.tx_index}`) ?? []), r]);
  const sum = {
    issued: new BigNumber(0),
    redeemed: new BigNumber(0),
    clawed_back: new BigNumber(0),
    transferred: new BigNumber(0),
  };
  let transfers = 0;
  let unknown = 0;
  for (const tx of byTx.values()) {
    const f = flowsOfTransaction(
      tx.map((c) => ({ before: c.amount_before, after: c.amount_after, beforeKnown: Number(c.before_known) === 1 })),
      tx.some((c) => Number(c.clawback) === 1),
    );
    sum.issued = sum.issued.plus(f.issued);
    sum.redeemed = sum.redeemed.plus(f.redeemed);
    sum.clawed_back = sum.clawed_back.plus(f.clawed_back);
    sum.transferred = sum.transferred.plus(f.transferred);
    transfers += f.transfers;
    unknown += f.unknown_before;
  }
  const t = (n: BigNumber) => (n.isZero() ? '0' : n.toFixed());
  return {
    issued: t(sum.issued),
    redeemed: t(sum.redeemed),
    clawed_back: t(sum.clawed_back),
    transferred: t(sum.transferred),
    transfers,
    changes: rows.length,
    unknown_before: unknown,
  };
}

describe('the token history routes', () => {
  describe('before the first generation', () => {
    let h: Harness;
    let api: ApiClient;

    beforeAll(async () => {
      h = await startHarness({ env: NO_RATE_LIMIT });
      api = await h.api();
    }, 120_000);
    afterAll(async () => {
      await h?.close();
    });

    it('404 token history is not built yet before the first generation', async () => {
      const issuer = 'rhub8VRN55s94qWKDv6jmDy1pUykJzF3wq';
      for (const path of [`/v2/tokens/USD.${issuer}/summary`, `/v2/issuers/${issuer}/tokens`]) {
        const res = await api.get(path);
        expect({ path, status: res.status, body: res.body }).toEqual({
          path,
          status: 404,
          body: { result: 'error', message: 'token history is not built yet' },
        });
        expect(res.headers['cache-control']).toBe('no-store');
      }
      // a 400 comes first
      expect((await api.get(`/v2/issuers/nobody/tokens`)).body.message).toBe('invalid issuer address');
    });
  });

  describe('on Xahau', () => {
    let h: Harness;

    beforeAll(async () => {
      h = await startHarness({ env: NO_RATE_LIMIT, network: 'xahau' });
    }, 120_000);
    afterAll(async () => {
      await h?.close();
    });

    it('on Xahau an issuance ID is token not found and no MPT table is read', async () => {
      const api = await h.api();
      const id = mptIssuanceId(1, 'rhub8VRN55s94qWKDv6jmDy1pUykJzF3wq');
      await expectNoMptRead(h, async () => {
        const res = await api.get(`/v2/tokens/${id}/summary`);
        expect({ status: res.status, message: res.body.message }).toEqual({ status: 404, message: 'token not found' });
      });
    });
  });

  describe('over the token history world', () => {
    let h: Harness;
    let api: ApiClient;
    let world: TokenHistoryWorld;
    let mpt: string;
    let usdPath: string;

    beforeAll(async () => {
      h = await startHarness({ env: NO_RATE_LIMIT });
      api = await h.api();
      const ch = h.ch;
      world = await seedTokenHistoryWorld(ch as never, new LedgerWriter(ch, CTX) as never);
      mpt = await seedGateMpt(ch, world);
      await seedExtremeToken(ch, world);
      await ch.command(
        `INSERT INTO ${Table.SyncerLease} (network, holder, heartbeat) SELECT 'xrpl:token_history', 'worker-1', now64(3)`,
      );
      await runTokenHistoryBuild(ch, { network: 'xrpl', hasMpt: true, threads: 2, log, leaseSettleMs: 0, ...SMALL });
      expect(await promoteIfCaughtUp(ch, await readTokenHistoryStates(ch))).toBe(true);
      usdPath = `/v2/tokens/USD.${world.gate}`;
    }, 300_000);
    afterAll(async () => {
      await h?.close();
    });

    it('issuer tokens lists issued tokens and MPTs by currency and pages', async () => {
      const whole = (await api.ok(`/v2/issuers/${world.gate}/tokens`, 'tokens')).body;
      expectSchema(whole, ISSUER_TOKENS_SCHEMA);
      const currencies = (whole.tokens as Obj[]).map((t) => t.currency);
      expect(currencies).toEqual([...currencies].sort());
      expect(currencies).toEqual(expect.arrayContaining([world.usd, 'XTR', mpt]));
      expect((whole.tokens as Obj[]).find((t) => t.currency === mpt)).toMatchObject({
        kind: 'mpt',
        supply: '107',
        holders: 2,
      });
      for (const t of whole.tokens as Obj[]) expectKeysInOrder(t, ISSUER_TOKEN_KEYS);
      // the totals equal the brute force
      const brute = await bruteForceTokens(h.ch as never, world.head);
      const usd = (whole.tokens as Obj[]).find((t) => t.currency === world.usd)!;
      const expected = brute.get(tokenMapKey({ issuer: world.gate, currency: world.usd }))!;
      expect({ supply: usd.supply, holders: usd.holders, trust_lines: usd.trust_lines }).toEqual(expected);
      // pages of one concatenate to the whole
      const pages = await api.pages<{ tokens: Obj[]; marker?: string }>(
        `/v2/issuers/${world.gate}/tokens`,
        1,
        'tokens',
      );
      expect(pages.flatMap((p) => p.tokens)).toEqual(whole.tokens);
      expect(pages.length).toBe(currencies.length);
      // the CSV
      const csv = await api.get(`/v2/issuers/${world.gate}/tokens?format=csv`);
      expect(csv.status).toBe(200);
      expect(csv.headers['content-disposition']).toContain(`${world.gate} - tokens.csv`);
    });

    it('an issuer with no token is an empty list', async () => {
      const body = (await api.ok(`/v2/issuers/${world.pool}/tokens`, 'tokens')).body;
      expect(body).toMatchObject({ result: 'success', count: 0, tokens: [] });
      expectSchema(body, ISSUER_TOKENS_SCHEMA);
    });

    it('summary totals equal the brute force at the head and at a past ledger', async () => {
      for (const n of [world.head, world.first + 3]) {
        const body = (await api.ok(`${usdPath}/summary?ledger_index=${n}`, 'supply')).body;
        const brute = (await bruteForceTokens(h.ch as never, n)).get(
          tokenMapKey({ issuer: world.gate, currency: world.usd }),
        )!;
        expect({ n, supply: body.supply, holders: body.holders, trust_lines: body.trust_lines }).toEqual({
          n,
          ...brute,
        });
        expect(body.ledger_index).toBe(n);
        expectKeysInOrder(body, SUMMARY_KEYS);
        expectSchema(body, SUMMARY_SCHEMA);
      }
      // without a ledger: the generation's newest
      expect((await api.ok(`${usdPath}/summary`, 'supply')).body.ledger_index).toBe(world.head);
    });

    it('the 24h window flows equal the sum of the brute-force flows of its ledgers', async () => {
      const body = (await api.ok(`${usdPath}/summary`, 'windows')).body;
      const w = (body.windows as Record<string, Obj>)['24h'];
      expectKeysInOrder(w, SUMMARY_WINDOW_KEYS);
      const brute = await bruteFlows(h.ch, { issuer: world.gate, currency: world.usd }, world.first, world.head);
      expect({
        issued: w.issued,
        redeemed: w.redeemed,
        clawed_back: w.clawed_back,
        transferred: w.transferred,
        transfers: w.transfers,
        changes: w.changes,
        unknown_before: w.unknown_before,
      }).toEqual(brute);
      expect(new BigNumber(w.clawed_back as string).gt(0)).toBe(true);
      // the windows end at the ledger's close
      expect(w.end).toBe(body.close_time);
    });

    it('exchanged is absent before the DEX history and present after, with exchanged_through', async () => {
      const before = (await api.ok(`${usdPath}/summary`, 'windows')).body;
      expect((before.windows as Record<string, Obj>)['24h']).not.toHaveProperty('exchanged');
      // the DEX history of the two hours before the head's hour, as the build and the worker write it
      const headHour = Math.floor(new Date(before.close_time as string).getTime() / 1000 / HOUR) * HOUR;
      const dex = (hour: number, issuer: string, currency: string, exchanged: string, trades: number) => ({
        issuer,
        currency,
        hour,
        exchanged,
        trades,
        config_version: 1,
        version: 5,
      });
      await h.ch.insert(Table.TokenHourlyDex, [
        dex(headHour - 2 * HOUR, world.gate, world.usd, '12.5', 3),
        dex(headHour - 2 * HOUR, '', '', '0', 0),
        dex(headHour - HOUR, '', '', '0', 0),
      ]);
      const after = (await api.ok(`${usdPath}/summary`, 'windows')).body;
      const w = (after.windows as Record<string, Obj>)['24h'];
      expect({ exchanged: w.exchanged, trades: w.trades, through: w.exchanged_through }).toEqual({
        exchanged: '12.5',
        trades: 3,
        through: `${new Date(headHour * 1000).toISOString().slice(0, 19)}Z`,
      });
      expectSchema(after, SUMMARY_SCHEMA);
    });

    it('summary of a token holding 9.999999999999999e80 and 1e-81 is exact', async () => {
      const body = (await api.ok(`/v2/tokens/XTR.${world.gate}/summary`, 'supply')).body;
      expect(body).toMatchObject({ supply: new BigNumber(HUGE).plus(TINY).toFixed(), holders: 2, trust_lines: 2 });
      expectSchema(body, SUMMARY_SCHEMA);
    });

    it('without_excluded with the issuer is the whole supply', async () => {
      const whole = (await api.ok(`${usdPath}/summary`, 'supply')).body;
      const body = (await api.ok(`${usdPath}/summary?exclude=${world.gate},${world.gate}`, 'supply')).body;
      expect(body.excluded).toEqual([world.gate]);
      expect(body.without_excluded).toEqual({
        supply: whole.supply,
        holders: whole.holders,
        trust_lines: whole.trust_lines,
      });
      // a holder's own balance comes off
      const [holder, line] = [...(await bruteForceLines(h.ch as never, world.head)).entries()].find(
        ([k, v]) =>
          k.startsWith(`${tokenMapKey({ issuer: world.gate, currency: world.usd })} `) &&
          new BigNumber(v.line.balance).gt(0),
      )!;
      const address = holder.split(' ')[2];
      const without = (await api.ok(`${usdPath}/summary?exclude=${address}`, 'supply')).body.without_excluded as Obj;
      expect(without).toEqual({
        supply: new BigNumber(whole.supply as string).minus(line.line.balance).toFixed(),
        holders: (whole.holders as number) - 1,
        trust_lines: (whole.trust_lines as number) - 1,
      });
      expectSchema(body, SUMMARY_SCHEMA);
    });

    it('404 token not found for an unknown token', async () => {
      for (const path of [
        `/v2/tokens/ZZZ.${world.gate}/summary`,
        `/v2/tokens/${mptIssuanceId(9, world.gate)}/summary`,
      ]) {
        const res = await api.get(path);
        expect({ path, status: res.status, message: res.body.message }).toEqual({
          path,
          status: 404,
          message: 'token not found',
        });
      }
      // and the 400s of the ledger
      expect((await api.get(`${usdPath}/summary?ledger_index=${world.head + 1}`)).body.message).toBe(
        'ledger is not in the token history yet',
      );
      expect((await api.get(`${usdPath}/summary?ledger_index=${world.first - 1}`)).body.message).toBe(
        'the date provided is too old',
      );
      expect((await api.get(`${usdPath}/summary?exclude=nobody`)).body.message).toBe('invalid ripple address');
    });

    describe('the supply series and the flows', () => {
      const iso = (t: number) => `${new Date(t * 1000).toISOString().slice(0, 19)}Z`;
      const usd = () => ({ issuer: world.gate, currency: world.usd });

      /** The ledgers with a change of gate's USD, in order. */
      async function changeLedgers(): Promise<number[]> {
        const rows = await h.ch.query<{ ledger_index: number }>(
          `SELECT DISTINCT ledger_index FROM ${Table.TokenHolderChanges}
            WHERE generation = 1 AND issuer = {issuer:String} AND currency = {currency:String} ORDER BY ledger_index`,
          usd(),
        );
        return rows.map((r) => Number(r.ledger_index));
      }

      it('interval ledger lists the ledgers with changes', async () => {
        const body = (await api.ok(`${usdPath}/supply?interval=ledger&limit=1000`, 'rows')).body;
        expectSchema(body, SUPPLY_SCHEMA);
        const rows = body.rows as Obj[];
        expect(rows.map((r) => r.ledger_index)).toEqual(await changeLedgers());
        for (const r of rows) {
          expectKeysInOrder(r, SUPPLY_ROW_KEYS);
          const brute = (await bruteForceTokens(h.ch as never, r.ledger_index as number)).get(tokenMapKey(usd()));
          expect({ l: r.ledger_index, supply: r.supply, holders: r.holders, trust_lines: r.trust_lines }).toEqual({
            l: r.ledger_index,
            ...(brute ?? { supply: '0', holders: 0, trust_lines: 0 }),
          });
        }
      });

      it('day buckets carry levels forward and sum their hours', async () => {
        const body = (await api.ok(`${usdPath}/supply`, 'rows')).body;
        expectSchema(body, SUPPLY_SCHEMA);
        expect(body.interval).toBe('day');
        const rows = body.rows as Obj[];
        const last = rows[rows.length - 1];
        const head = (await bruteForceTokens(h.ch as never, world.head)).get(tokenMapKey(usd()))!;
        expect({ supply: last.supply, holders: last.holders, trust_lines: last.trust_lines }).toEqual(head);
        // the day's flows are those of every ledger of the day: here the whole world
        const flows = await bruteFlows(h.ch, usd(), world.first, world.head);
        const summed = rows.reduce<{ issued: BigNumber; redeemed: BigNumber; clawed_back: BigNumber }>(
          (s, r) => ({
            issued: s.issued.plus(r.issued as string),
            redeemed: s.redeemed.plus(r.redeemed as string),
            clawed_back: s.clawed_back.plus(r.clawed_back as string),
          }),
          { issued: new BigNumber(0), redeemed: new BigNumber(0), clawed_back: new BigNumber(0) },
        );
        expect({
          issued: summed.issued.toFixed(),
          redeemed: summed.redeemed.toFixed(),
          clawed_back: summed.clawed_back.toFixed(),
        }).toEqual({
          issued: flows.issued,
          redeemed: flows.redeemed,
          clawed_back: flows.clawed_back,
        });
        // by the hour, the same levels at the end
        const hourly = (await api.ok(`${usdPath}/supply?interval=hour`, 'rows')).body.rows as Obj[];
        expect(hourly[hourly.length - 1].supply).toBe(last.supply);
      });

      it('pages concatenate to the unpaged series in both directions', async () => {
        for (const descending of [false, true]) {
          const path = `${usdPath}/supply?interval=ledger&descending=${descending}`;
          const whole = (await api.ok(`${path}&limit=1000`, 'rows')).body.rows as Obj[];
          const pages = await api.pages<{ rows: Obj[]; marker?: string }>(path, 3, 'rows');
          expect({ descending, rows: pages.flatMap((p) => p.rows) }).toEqual({ descending, rows: whole });
          expect(pages.length).toBeGreaterThan(1);
        }
      });

      it('exclude adds without_excluded to every row', async () => {
        const [key, line] = [...(await bruteForceLines(h.ch as never, world.head)).entries()].find(
          ([k, v]) => k.startsWith(`${tokenMapKey(usd())} `) && new BigNumber(v.line.balance).gt(0),
        )!;
        const holder = key.split(' ')[2];
        const body = (await api.ok(`${usdPath}/supply?interval=ledger&limit=1000&exclude=${holder}`, 'rows')).body;
        expectSchema(body, SUPPLY_SCHEMA);
        expect(body.excluded).toEqual([holder]);
        const rows = body.rows as Obj[];
        expect(rows.every((r) => r.without_excluded !== undefined)).toBe(true);
        const last = rows[rows.length - 1];
        expect((last.without_excluded as Obj).supply).toBe(
          new BigNumber(last.supply as string).minus(line.line.balance).toFixed(),
        );
        const day = (await api.ok(`${usdPath}/supply?exclude=${holder}`, 'rows')).body.rows as Obj[];
        expect(day[day.length - 1].without_excluded).toEqual(last.without_excluded);
        // the CSV has the three columns
        const csv = await api.get(`${usdPath}/supply?interval=ledger&exclude=${holder}&format=csv`);
        expect(csv.text.split('\n')[0]).toContain('without_excluded.supply');
      });

      it('flows totals equal the sum of the periods, and top counterparties equal the brute force', async () => {
        const close = await closeTimes(h.ch);
        const start = close.get(world.first)! - HOUR;
        const end = close.get(world.head)! + HOUR;
        const body = (
          await api.ok(`${usdPath}/flows?start=${iso(start)}&end=${iso(end)}&interval=hour&counterparties=3`, 'totals')
        ).body;
        expectSchema(body, FLOWS_SCHEMA);
        expectKeysInOrder(body, FLOWS_KEYS);
        const brute = await bruteFlows(h.ch, usd(), world.first, world.head);
        const totals = body.totals as Obj;
        expect({ ...totals }).toMatchObject({
          issued: brute.issued,
          redeemed: brute.redeemed,
          clawed_back: brute.clawed_back,
          transferred: brute.transferred,
          transfers: brute.transfers,
          unknown_before: brute.unknown_before,
        });
        const periods = body.periods as Obj[];
        const sum = (k: string) => periods.reduce((s, p) => s.plus(p[k] as string), new BigNumber(0)).toFixed();
        expect({ issued: sum('issued'), transferred: sum('transferred') }).toEqual({
          issued: totals.issued,
          transferred: totals.transferred,
        });
        expect(periods.length).toBeGreaterThanOrEqual(2);
        // the counterparties, by the change log
        const changes = await h.ch.query<{
          holder: string;
          amount_before: string;
          amount_after: string;
          before_known: number;
        }>(
          `SELECT holder, amount_before, amount_after, before_known FROM ${Table.TokenHolderChanges}
            WHERE generation = 1 AND issuer = {issuer:String} AND currency = {currency:String}
            LIMIT 1 BY ledger_index, tx_index, node_index, holder`,
          usd(),
        );
        const by = new Map<string, { received: BigNumber; sent: BigNumber; changes: number }>();
        for (const c of changes) {
          const s = by.get(c.holder) ?? { received: new BigNumber(0), sent: new BigNumber(0), changes: 0 };
          s.changes += 1;
          if (Number(c.before_known) === 1) {
            const d = new BigNumber(c.amount_after).minus(c.amount_before);
            if (d.gt(0)) s.received = s.received.plus(d);
            else s.sent = s.sent.minus(d);
          }
          by.set(c.holder, s);
        }
        const top = [...by.entries()]
          .sort(([a, x], [b, y]) => y.received.plus(y.sent).comparedTo(x.received.plus(x.sent)) || (a < b ? -1 : 1))
          .slice(0, 3)
          .map(([account, s]) => ({
            account,
            received: s.received.toFixed(),
            sent: s.sent.toFixed(),
            net: s.received.minus(s.sent).toFixed(),
            changes: s.changes,
          }));
        expect(body.counterparties).toEqual(top);
      });

      it('367 days is window too large, and hour over 32 days is window too large', async () => {
        const message = async (q: string) => (await api.get(`${usdPath}/flows?${q}`)).body.message;
        expect(await message('start=2024-01-01&end=2025-01-01')).toBe('window too large');
        expect(await message('start=2024-01-02&end=2025-01-01')).not.toBe('window too large');
        expect(await message('start=2024-01-01&end=2024-02-01&interval=hour')).toBe('window too large');
        expect(await message('start=2024-01-01&end=2024-01-31&interval=hour')).not.toBe('window too large');
        expect(await message('end=2024-01-31')).toBe('invalid start date format');
        expect(await message('start=2024-01-01&end=2024-01-31&interval=week')).toBe(
          'invalid interval - use: day, hour, month',
        );
        expect((await api.get(`${usdPath}/supply?interval=week`)).body.message).toBe(
          'invalid interval - use: day, hour, ledger',
        );
      });
    });

    it('every answer validates against its schema', async () => {
      const mptBody = (await api.ok(`/v2/tokens/${mpt}/summary`, 'supply')).body;
      expect(mptBody).toMatchObject({
        token: { currency: mpt, issuer: world.gate, kind: 'mpt' },
        supply: '107',
        holders: 2,
      });
      expectSchema(mptBody, SUMMARY_SCHEMA);
      expectSchema((await api.ok(`/v2/issuers/${world.nostate}/tokens`, 'tokens')).body, ISSUER_TOKENS_SCHEMA);
      expectSchema((await api.ok(`/v2/tokens/USD.${world.plain}/summary`, 'supply')).body, SUMMARY_SCHEMA);
    });
  });

  describe('a window of many ledgers', () => {
    let h: Harness;

    beforeAll(async () => {
      h = await startHarness({ env: NO_RATE_LIMIT });
      const ch = h.ch;
      const world = await seedTokenHistoryWorld(ch as never, new LedgerWriter(ch, CTX) as never, { first: 300_000 });
      await ch.command(
        `INSERT INTO ${Table.SyncerLease} (network, holder, heartbeat) SELECT 'xrpl:token_history', 'worker-1', now64(3)`,
      );
      await runTokenHistoryBuild(ch, { network: 'xrpl', hasMpt: true, threads: 2, log, leaseSettleMs: 0, ...SMALL });
      expect(await promoteIfCaughtUp(ch, await readTokenHistoryStates(ch))).toBe(true);
      (h as unknown as { world: TokenHistoryWorld }).world = world;
    }, 300_000);
    afterAll(async () => {
      await h?.close();
    });

    it('interval ledger over 100,001 ledgers is window too large for interval ledger', async () => {
      const api = await h.api();
      const world = (h as unknown as { world: TokenHistoryWorld }).world;
      const path = `/v2/tokens/USD.${world.gate}/supply?interval=ledger`;
      // a stored ledger 200,000 below the world, 40 days before it (as a fill in progress leaves one)
      const close = await closeTimes(h.ch);
      const old = close.get(world.first)! - 40 * 86_400;
      const [first] = await h.ch.query<Obj>(
        `SELECT * EXCEPT (close_time), toUnixTimestamp(close_time) AS close_time FROM ${Table.Ledgers} WHERE ledger_index = {l:UInt32}`,
        { l: world.first },
      );
      await h.ch.insert(Table.Ledgers, [
        { ...first, ledger_index: world.first - 200_000, ledger_hash: 'F'.repeat(64), close_time: old },
      ]);
      const iso = `${new Date(old * 1000).toISOString().slice(0, 19)}Z`;
      const res = await api.get(`${path}&start=${iso}`);
      expect({ status: res.status, message: res.body.message }).toEqual({
        status: 400,
        message: 'window too large for interval ledger',
      });
      // the default window, from the token's first change, is not
      expect((await api.get(path)).status).toBe(200);
      // nor a window of the world's own ledgers, by the hour
      expect((await api.get(`/v2/tokens/USD.${world.gate}/supply?interval=hour&start=${iso}`)).status).toBe(200);
    });
  });
});
