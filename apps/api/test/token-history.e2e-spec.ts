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
import { ISSUER_TOKENS_SCHEMA, SUMMARY_SCHEMA } from '../src/token-history/schemas';
import { ISSUER_TOKEN_KEYS, SUMMARY_KEYS, SUMMARY_WINDOW_KEYS } from '../src/token-history/token-history-objects';
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
});
