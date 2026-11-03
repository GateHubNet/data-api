import { STATE_PARSER_VERSION, Table, TrustLineStatesRow } from '@gatehub/data-api-shared';
import { ApiClient, Harness, NO_RATE_LIMIT, startHarness } from './harness';
import { csvDisposition } from './support/csv';
import { liveNode } from './support/live-node';

/**
 * `GET /v2/accounts/:address/trustlines`: the trust lines of an account at a ledger, with all their settings, from the
 * trust line state history in ClickHouse (ADR-0015). It never asks the node: with no ledger named it reads the newest
 * indexed one.
 *
 * The cases are recorded mainnet ledgers (`xrpl/account-state`, see the fixtures README): an LBR line whose holder sets
 * qualities, freezes it and unfreezes it; the USDV issuer, which authorizes its holders, with a line created with a zero
 * balance and deleted again; and the TUJ issuer, whose holders and AMM pool created their lines in two ledgers.
 */

/** The holder of an LBR line of `LBR_ISSUER` (the high side): qualities 1/1 in 26922216, frozen in 26926380, unfrozen in 26926383. */
const LBR_HOLDER = 'rKQxxMQxm6jHV82bq4BCwyfcxcGG9GPWiU';
const LBR_ISSUER = 'rsbgrRPMTykHoStSYst8jbqkscAnHCPWY8';

/** The USDV issuer: it requires authorization, and authorizes its holders with TrustSet `tfSetfAuth`. */
const USDV_ISSUER = 'rfffsukWALJB1PXYk7H8xkR6UJUDT8nMJE';
const USDV = '5553445600000000000000000000000000000000';
/** 104477592: the issuer creates this holder's line, authorized, with nothing on it. */
const USDV_PREAUTHORIZED = 'rJdo3ig1gWqLQQrs6wjbEeLNf3aGsR8qfD';
/** An AMM pool: its USDV line is created by AMMCreate in 104478769, and the issuer authorizes it in 104479125. */
const USDV_POOL = 'rPZZja3wKFEmAGGteziXYLT9Ne6SnT7H66';
/** It created the pool and put all its USDV in it (104478769): its line stays, at zero. */
const USDV_POOL_CREATOR = 'rBmxD2HRymXtKZdZnczVZrcfhGvv2qEcom';
/** Creates a USDV line with a zero balance in 104566877 and deletes it in 104566926. */
const USDV_DELETER = 'rsMeJ5p6qzVARADTYhvZbHqwkfyN18U2XH';
/** Two holders whose USDV moves in 107671593 (a Payment through the pool of rPYC3U…). */
const USDV_PAID = 'rMRuSd79boP4oUYgVS6XGeJT4s4bzbMK3N';
const USDV_POOL_2 = 'rPYC3UxENzfpiBtzZcey74EGHFZg2FTLSx';

/** The TUJ issuer: holders and an AMM pool create lines to it in 93663330 and 93663334. */
const TUJ_ISSUER = 'rKqSPjN6okYt7iPk3xzWvuW9oN1Nk7vSUV';
/** The TUJ pool, created in 93663330; the issuer holds its LP token from 93663334. */
const TUJ_POOL = 'rGuYK1v7kyrKEa86wPN2M9CHpT9LiWFr5m';
const TUJ_LP = '03F5BC4D66B44AEAD668A84F094E08C8C13F5EE2';

/** The newest recorded ledger, and the one with no ledger named. */
const NEWEST = 107872958;

/** A line with every setting off and nothing on it: the tests spell out what differs. */
const BLANK = {
  balance: '0',
  limit: '0',
  limit_peer: '0',
  no_ripple: false,
  no_ripple_peer: false,
  authorized: false,
  peer_authorized: false,
  freeze: false,
  peer_freeze: false,
  quality_in: 0,
  quality_out: 0,
};

function line(currency: string, counterparty: string, settings: Partial<typeof BLANK> = {}) {
  return { currency, counterparty, ...BLANK, ...settings };
}

/** The TUJ issuer's lines at 93663334, in (counterparty, currency) order: its holders hold TUJ, so its balances are negative. */
const TUJ_LINES = [
  line(TUJ_LP, TUJ_POOL, { balance: '141421356.2373095', limit: '141421357', no_ripple: true }),
  line('TUJ', TUJ_POOL, { balance: '-87637118.62037774' }),
  line('TUJ', 'rKeNzBwMPm1hbxmFfAu3iy85iXqsrfbdW5', { balance: '-767234.46269743', no_ripple_peer: true }),
  line('TUJ', 'rXPMxDRxMM6JLk8AMVh569iap3TtnjaF3', {
    balance: '-800000000',
    limit_peer: '1000000000',
    no_ripple_peer: true,
  }),
  line('TUJ', 'raJHgTNASWNsg4BvMEQ4tcLtTgGGfE19Wf', { balance: '-4886027.6593725', no_ripple_peer: true }),
  line('TUJ', 'rd7zuWvrgTMfcy4ezRTRYVHgpai1St5Q4', {
    balance: '-2032147.83066483',
    limit_peer: '1000000000',
    no_ripple_peer: true,
  }),
  line('TUJ', 'rfiTZj7HvwBajwkMJ7CVzbWFA9dsXe7ow3', { balance: '-1176453.86673002', no_ripple_peer: true }),
  line('TUJ', 'rhRXL16HqqbLMV266jct2Enyjspr7m39CJ', { balance: '-4355078.04727168', no_ripple_peer: true }),
  line('TUJ', 'rhbj4x2i7hiwoWb7vQZ16XmnAKPcLtepDX', { balance: '-921224.3812527', no_ripple_peer: true }),
];

const TOO_OLD = { result: 'error', message: 'the date provided is too old' };

describe('GET /v2/accounts/:address/trustlines', () => {
  describe('the recorded ledgers (xrpl-account-state)', () => {
    const node = liveNode();
    let h: Harness;
    let api: ApiClient;

    beforeAll(async () => {
      h = await startHarness({ seed: 'xrpl-account-state', xrplStub: node.stub, env: NO_RATE_LIMIT });
      api = await h.api();
    });
    afterAll(async () => {
      await h?.close();
    });
    // the route never asks the node: every test ends with no request recorded
    beforeEach(() => node.serve(() => ({})));
    afterEach(() => expect(node.requests()).toEqual([]));

    const linesAt = async (account: string, query: string) => {
      const res = await api.get(`/v2/accounts/${account}/trustlines?${query}`);
      expect({ account, query, status: res.status }).toEqual({ account, query, status: 200 });
      return res.body;
    };

    describe('TrustSet settings', () => {
      it('a TrustSet with a limit and qualities: the line as the holder sees it, at that ledger', async () => {
        expect(await linesAt(LBR_HOLDER, 'ledger_index=26922216')).toEqual({
          result: 'success',
          ledger_index: 26922216,
          close_time: '2017-01-12T14:30:01Z',
          count: 1,
          trustlines: [
            line('LBR', LBR_ISSUER, {
              balance: '5.017529627551844',
              limit: '10000000',
              limit_peer: '1000000',
              quality_in: 1,
              quality_out: 1,
            }),
          ],
        });
      });

      it('the other side of the same line: the issuer owes the balance, and the limits swap', async () => {
        expect((await linesAt(LBR_ISSUER, 'ledger_index=26922216')).trustlines).toEqual([
          line('LBR', LBR_HOLDER, { balance: '-5.017529627551844', limit: '1000000', limit_peer: '10000000' }),
        ]);
      });

      it('a TrustSet that freezes the line and clears the qualities: freeze on its side, peer_freeze on the other', async () => {
        const holder = await linesAt(LBR_HOLDER, 'ledger_index=26926380');
        expect(holder.trustlines).toEqual([
          line('LBR', LBR_ISSUER, {
            balance: '5.017529627551844',
            limit: '10000000',
            limit_peer: '1000000',
            freeze: true,
          }),
        ]);
        expect(holder.close_time).toBe('2017-01-12T18:49:31Z');
        expect((await linesAt(LBR_ISSUER, 'ledger_index=26926380')).trustlines).toEqual([
          line('LBR', LBR_HOLDER, {
            balance: '-5.017529627551844',
            limit: '1000000',
            limit_peer: '10000000',
            peer_freeze: true,
          }),
        ]);
      });

      it('a TrustSet that unfreezes it again', async () => {
        const [lbr] = (await linesAt(LBR_HOLDER, 'ledger_index=26926383')).trustlines;
        expect(lbr).toEqual(
          line('LBR', LBR_ISSUER, { balance: '5.017529627551844', limit: '10000000', limit_peer: '1000000' }),
        );
      });

      it("authorization: the issuer's TrustSet authorizes a pool's line, which was not authorized before it", async () => {
        const before = await linesAt(USDV_POOL, `ledger_index=104478769&counterparty=${USDV_ISSUER}`);
        expect(before.trustlines).toEqual([line(USDV, USDV_ISSUER, { balance: '700000' })]);
        const after = await linesAt(USDV_POOL, `ledger_index=104479125&counterparty=${USDV_ISSUER}`);
        expect(after.trustlines).toEqual([line(USDV, USDV_ISSUER, { balance: '700000', peer_authorized: true })]);
      });

      it('no-ripple: the line the issuer creates, authorized, has no-ripple on the holder side', async () => {
        expect((await linesAt(USDV_PREAUTHORIZED, 'ledger_index=104477592')).trustlines).toEqual([
          line(USDV, USDV_ISSUER, { no_ripple: true, peer_authorized: true }),
        ]);
        expect((await linesAt(USDV_ISSUER, 'ledger_index=104477592')).trustlines).toEqual([
          line(USDV, USDV_PREAUTHORIZED, { authorized: true, no_ripple_peer: true }),
        ]);
      });
    });

    describe('a line created with a zero balance and deleted later', () => {
      it('is listed, at zero, from the ledger that created it', async () => {
        expect((await linesAt(USDV_DELETER, 'ledger_index=104566877')).trustlines).toEqual([
          line(USDV, USDV_ISSUER, { limit: '3251000', no_ripple: true }),
        ]);
      });

      it('is not listed from the ledger that deleted it on', async () => {
        for (const query of ['ledger_index=104566926', 'ledger_index=107671593', '']) {
          const body = await linesAt(USDV_DELETER, query);
          expect({ query, count: body.count, trustlines: body.trustlines }).toEqual({
            query,
            count: 0,
            trustlines: [],
          });
        }
      });

      it('is not listed before the ledger that created it either', async () => {
        expect((await linesAt(USDV_DELETER, 'ledger_index=104479125')).trustlines).toEqual([]);
      });
    });

    describe("an issuer's lines are its holders", () => {
      /** The USDV holders at 104566877, ordered by counterparty: the zero lines are there, the deleter's among them. */
      const HOLDERS_104566877 = [
        line(USDV, USDV_POOL_CREATOR, { limit_peer: '7000000', authorized: true, no_ripple_peer: true }),
        line(USDV, USDV_PREAUTHORIZED, { authorized: true, no_ripple_peer: true }),
        line(USDV, USDV_POOL, { balance: '-700000', authorized: true }),
        line(USDV, USDV_DELETER, { limit_peer: '3251000', no_ripple_peer: true }),
      ];

      it('every holder, with its settings, ordered by counterparty', async () => {
        const body = await linesAt(USDV_ISSUER, 'ledger_index=104566877');
        expect(body.count).toBe(4);
        expect(body.trustlines).toEqual(HOLDERS_104566877);
      });

      it('a deleted line is gone from the holders too', async () => {
        expect((await linesAt(USDV_ISSUER, 'ledger_index=104566926')).trustlines).toEqual(
          HOLDERS_104566877.filter((l) => l.counterparty !== USDV_DELETER),
        );
      });

      it('with no ledger named: the newest indexed ledger, with the balances of its last changes', async () => {
        const body = await linesAt(USDV_ISSUER, '');
        expect(body.ledger_index).toBe(NEWEST);
        expect(body.close_time).toBe('2026-10-24T14:17:20Z');
        expect(body.trustlines).toEqual([
          HOLDERS_104566877[0],
          HOLDERS_104566877[1],
          line(USDV, USDV_PAID, {
            balance: '-259296.5248135383',
            limit_peer: '100000000',
            authorized: true,
          }),
          line(USDV, USDV_POOL_2, { balance: '-121900.1151686239', authorized: true }),
          HOLDERS_104566877[2],
        ]);
      });

      it('the TUJ issuer: its holders, an AMM pool and the LP token it holds itself', async () => {
        const body = await linesAt(TUJ_ISSUER, 'ledger_index=93663334');
        expect(body.count).toBe(TUJ_LINES.length);
        expect(body.trustlines).toEqual(TUJ_LINES);
      });
    });

    describe('the ledger', () => {
      it('validated, closed and current read the newest indexed ledger too, never the node', async () => {
        for (const word of ['validated', 'closed', 'current']) {
          const body = await linesAt(USDV_ISSUER, `ledger_index=${word}`);
          expect({ word, ledger_index: body.ledger_index }).toEqual({ word, ledger_index: NEWEST });
        }
      });

      it('a date reads the last ledger closed at or before it, and close_time is its alias', async () => {
        for (const query of ['date=2017-01-12T15:00:00Z', 'close_time=2017-01-12T15:00:00Z']) {
          const body = await linesAt(LBR_HOLDER, query);
          expect({ query, ledger_index: body.ledger_index, close_time: body.close_time }).toEqual({
            query,
            ledger_index: 26922216,
            close_time: '2017-01-12T14:30:01Z',
          });
          expect(body.trustlines[0].quality_in).toBe(1);
        }
      });

      it('ledger is an alias of ledger_index', async () => {
        expect((await linesAt(LBR_HOLDER, 'ledger=26926380')).ledger_index).toBe(26926380);
      });

      it('a ledger hash names its ledger, in any case', async () => {
        const hash = '98BB69974A0476D080063951217515492C259ACF2DE26F69A00778B0F68CBED8';
        const body = await linesAt(LBR_HOLDER, `ledger_hash=${hash.toLowerCase()}`);
        expect(body.ledger_index).toBe(26926380);
        expect(body.trustlines[0].freeze).toBe(true);
      });

      it('the precedence of /balances: a hash wins over a date, a date over a ledger number', async () => {
        const hash = 'EE25A94D1F890106BE932CA73A9DCFA6CDF7813C61C7F92D0AF4A260FF008BAC';
        const all = await linesAt(LBR_HOLDER, `ledger_hash=${hash}&date=2017-01-12T15:00:00Z&ledger_index=26926380`);
        expect(all.ledger_index).toBe(26926383);
        const dateAndIndex = await linesAt(LBR_HOLDER, 'date=2017-01-12T15:00:00Z&ledger_index=26926380');
        expect(dateAndIndex.ledger_index).toBe(26922216);
      });

      it('a ledger between two recorded ones reads the state of the last change at or before it', async () => {
        const body = await linesAt(LBR_HOLDER, 'ledger_index=26926383');
        expect(body.ledger_index).toBe(26926383);
        // the LBR line last changed in 26926383; the USDV deleter has no line before or after
        expect((await linesAt(USDV_POOL, `ledger_index=104566926&counterparty=${USDV_ISSUER}`)).trustlines).toEqual([
          line(USDV, USDV_ISSUER, { balance: '700000', peer_authorized: true }),
        ]);
      });
    });

    describe('the filters', () => {
      it('currency keeps the lines in that currency', async () => {
        const body = await linesAt(TUJ_ISSUER, 'ledger_index=93663334&currency=TUJ');
        expect(body.trustlines).toEqual(TUJ_LINES.filter((l) => l.currency === 'TUJ'));
        expect(body.count).toBe(8);
      });

      it('counterparty keeps the lines with that account', async () => {
        const body = await linesAt(TUJ_ISSUER, `ledger_index=93663334&counterparty=${TUJ_POOL}`);
        expect(body.trustlines).toEqual(TUJ_LINES.slice(0, 2));
      });

      it('both together keep one line, and a currency nobody holds keeps none', async () => {
        const one = await linesAt(TUJ_ISSUER, `ledger_index=93663334&counterparty=${TUJ_POOL}&currency=TUJ`);
        expect(one.trustlines).toEqual([TUJ_LINES[1]]);
        const none = await linesAt(TUJ_ISSUER, 'ledger_index=93663334&currency=USD');
        expect(none).toEqual({
          result: 'success',
          ledger_index: 93663334,
          close_time: '2025-01-24T00:37:02Z',
          count: 0,
          trustlines: [],
        });
      });
    });

    describe('paging', () => {
      it('limit cuts the page, and marker continues after its last line, until the last page has no marker', async () => {
        const first = await api.get(`/v2/accounts/${TUJ_ISSUER}/trustlines?ledger_index=93663334&limit=4`);
        expect(first.status).toBe(200);
        expect(first.body.count).toBe(4);
        expect(first.body.trustlines).toEqual(TUJ_LINES.slice(0, 4));
        expect(typeof first.body.marker).toBe('string');
        expect(first.headers.link).toContain(`marker=${first.body.marker}`);
        expect(Object.keys(first.body)).toEqual([
          'result',
          'ledger_index',
          'close_time',
          'count',
          'marker',
          'trustlines',
        ]);

        const second = await api.get(
          `/v2/accounts/${TUJ_ISSUER}/trustlines?ledger_index=93663334&limit=4&marker=${first.body.marker}`,
        );
        expect(second.body.trustlines).toEqual(TUJ_LINES.slice(4, 8));
        const last = await api.get(
          `/v2/accounts/${TUJ_ISSUER}/trustlines?ledger_index=93663334&limit=4&marker=${second.body.marker}`,
        );
        expect(last.body.trustlines).toEqual(TUJ_LINES.slice(8));
        expect(last.body.count).toBe(1);
        expect(last.body.marker).toBeUndefined();
        expect(last.headers.link).toBeUndefined();
      });

      it('the pages of a walk are the whole list, once', async () => {
        const pages = await api.pages<{ marker?: string; trustlines: unknown[] }>(
          `/v2/accounts/${TUJ_ISSUER}/trustlines?ledger_index=93663334`,
          2,
          'trustlines',
        );
        expect(pages).toHaveLength(5);
        expect(pages.flatMap((p) => p.trustlines)).toEqual(TUJ_LINES);
      });

      it('a list that fits in one page has no marker', async () => {
        const body = await linesAt(TUJ_ISSUER, 'ledger_index=93663334&limit=9');
        expect(body.count).toBe(9);
        expect(body.marker).toBeUndefined();
        expect(Object.keys(body)).toEqual(['result', 'ledger_index', 'close_time', 'count', 'trustlines']);
      });

      it('a line has its keys in the order of the API', async () => {
        const [first] = (await linesAt(LBR_HOLDER, 'ledger_index=26922216')).trustlines;
        expect(Object.keys(first)).toEqual([
          'currency',
          'counterparty',
          'balance',
          'limit',
          'limit_peer',
          'no_ripple',
          'no_ripple_peer',
          'authorized',
          'peer_authorized',
          'freeze',
          'peer_freeze',
          'quality_in',
          'quality_out',
        ]);
      });
    });

    describe('format=csv', () => {
      it('a file named after the address, with one row per line', async () => {
        const res = await api.get(`/v2/accounts/${TUJ_ISSUER}/trustlines?ledger_index=93663330&format=csv`);
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/^text\/csv/);
        expect(res.headers['content-disposition']).toBe(csvDisposition(`${TUJ_ISSUER} - trustlines`));
        expect(res.text.split('\n')).toEqual([
          '"currency","counterparty","balance","limit","limit_peer","no_ripple","no_ripple_peer","authorized","peer_authorized","freeze","peer_freeze","quality_in","quality_out"',
          `"TUJ","${TUJ_POOL}","-200000000","0","0","false","false","false","false","false","false","0","0"`,
          `"TUJ","rXPMxDRxMM6JLk8AMVh569iap3TtnjaF3","-800000000","0","1000000000","false","true","false","false","false","false","0","0"`,
        ]);
      });

      it('pages like the JSON, with the marker in the Link header', async () => {
        const res = await api.get(`/v2/accounts/${TUJ_ISSUER}/trustlines?ledger_index=93663334&limit=1&format=CSV`);
        expect(res.status).toBe(200);
        expect(res.text.split('\n')).toHaveLength(2);
        expect(res.headers.link).toContain('marker=');
      });
    });

    describe('errors', () => {
      const error = async (path: string) => {
        const res = await api.get(path);
        return { status: res.status, body: res.body };
      };
      const bad = (message: string) => ({ status: 400, body: { result: 'error', message } });

      it('an address that is none is 400 invalid ripple address, before anything else', async () => {
        expect(await error('/v2/accounts/rNotAnAddress/trustlines?date=yesterday&marker=!')).toEqual(
          bad('invalid ripple address'),
        );
      });

      it('then a malformed date, then a malformed hash', async () => {
        expect(await error(`/v2/accounts/${LBR_HOLDER}/trustlines?date=yesterday&ledger_hash=ABC`)).toEqual(
          bad('invalid date format'),
        );
        expect(await error(`/v2/accounts/${LBR_HOLDER}/trustlines?ledger_hash=ABC&limit=x`)).toEqual(
          bad('invalid ledger hash'),
        );
      });

      it('then a limit that is not a number, then a marker that is not one of this list', async () => {
        expect(await error(`/v2/accounts/${LBR_HOLDER}/trustlines?limit=x&marker=!`)).toEqual(bad('invalid limit'));
        for (const marker of [
          '!',
          Buffer.from('[1,2]').toString('base64url'),
          Buffer.from('["a"]').toString('base64url'),
        ]) {
          expect(await error(`/v2/accounts/${LBR_HOLDER}/trustlines?marker=${marker}`)).toEqual(bad('invalid marker'));
        }
      });

      it('a ledger this API does not hold, or a date before the first one, is 400 the date provided is too old', async () => {
        for (const query of ['ledger_index=26922215', `ledger_hash=${'AB'.repeat(32)}`, 'date=2015-01-01T00:00:00Z']) {
          expect({ query, ...(await error(`/v2/accounts/${LBR_HOLDER}/trustlines?${query}`)) }).toEqual({
            query,
            status: 400,
            body: TOO_OLD,
          });
        }
      });
    });
  });

  describe('the limit (lines written by hand at the newest ledger)', () => {
    const ACCOUNT = 'rKQxxMQxm6jHV82bq4BCwyfcxcGG9GPWiU';
    let h: Harness;
    let api: ApiClient;

    beforeAll(async () => {
      h = await startHarness({ seed: 'xrpl-account-state', env: NO_RATE_LIMIT });
      api = await h.api();
      // 1100 USD lines of ACCOUNT at the newest ledger, one per counterparty
      const rows: TrustLineStatesRow[] = Array.from({ length: 1100 }, (_, i) => ({
        account: ACCOUNT,
        counterparty: `r${String(i).padStart(5, '0')}`,
        currency: 'USD',
        ledger_index: NEWEST,
        tx_index: 0,
        node_index: i,
        tx_hash: 'A'.repeat(64),
        close_time: 1_792_851_440,
        balance: '1',
        limit: '10',
        limit_peer: '0',
        no_ripple: 0,
        no_ripple_peer: 0,
        authorized: 0,
        peer_authorized: 0,
        freeze: 0,
        peer_freeze: 0,
        quality_in: 0,
        quality_out: 0,
        flags: 0,
        deleted: 0,
      }));
      await h.ch.insert(Table.TrustLineStates, rows);
    });
    afterAll(async () => {
      await h?.close();
    });

    it('is 200 by default and 1000 at most; below one is the default', async () => {
      for (const [query, count] of [
        ['', 200],
        ['limit=5000', 1000],
        ['limit=1000', 1000],
        ['limit=0', 200],
        ['limit=7.9', 7],
      ] as const) {
        const res = await api.get(`/v2/accounts/${ACCOUNT}/trustlines?${query}`);
        expect({ query, status: res.status, count: res.body.count, lines: res.body.trustlines.length }).toEqual({
          query,
          status: 200,
          count,
          lines: count,
        });
      }
    });
  });

  describe('the coverage of the state tables (a ledger an older parser wrote)', () => {
    /** Written by parser version 2 between the LBR ledgers and the TUJ ones: the coverage starts above it. */
    const OLDER = 30_000_000;
    let h: Harness;
    let api: ApiClient;

    /** A `ledgers` row written by a parser that did not record state yet, with this index and close time. */
    const insertOlderParserLedger = (on: Harness, ledger: number, closeTime: number) =>
      on.ch.command(
        `INSERT INTO ${Table.Ledgers}
         SELECT tpl.* REPLACE (toUInt32({ledger:UInt32}) AS ledger_index, toDateTime({time:UInt32}, 'UTC') AS close_time,
                               {hash:String} AS ledger_hash, toUInt16({version:UInt16}) AS parser_version)
           FROM (SELECT * FROM ${Table.Ledgers} ORDER BY ledger_index LIMIT 1) AS tpl`,
        {
          ledger,
          time: closeTime,
          hash: ledger.toString(16).toUpperCase().padStart(64, '0'),
          version: STATE_PARSER_VERSION - 1,
        },
      );

    beforeAll(async () => {
      h = await startHarness({ seed: 'xrpl-account-state' });
      api = await h.api();
      await insertOlderParserLedger(h, OLDER, 1_500_000_000);
    });
    afterAll(async () => {
      await h?.close();
    });

    it('a ledger at or below the newest one an older parser wrote is too old, even one the newer parser wrote', async () => {
      for (const query of ['ledger_index=26926380', `ledger_index=${OLDER}`, 'date=2017-06-01T00:00:00Z']) {
        const res = await api.get(`/v2/accounts/${LBR_HOLDER}/trustlines?${query}`);
        expect({ query, status: res.status, body: res.body }).toEqual({ query, status: 400, body: TOO_OLD });
      }
    });

    it('a ledger above it is covered', async () => {
      const res = await api.get(`/v2/accounts/${TUJ_ISSUER}/trustlines?ledger_index=93663334`);
      expect(res.status).toBe(200);
      expect(res.body.trustlines).toEqual(TUJ_LINES);
    });

    it('with no ledger named, a newest ledger an older parser wrote is too old as well', async () => {
      // its own harness: the coverage is cached, and this one is decided before the first read
      const older = await startHarness({ seed: 'xrpl-account-state' });
      try {
        await insertOlderParserLedger(older, NEWEST + 1, 1_792_851_450);
        const res = await (await older.api()).get(`/v2/accounts/${TUJ_ISSUER}/trustlines`);
        expect(res.status).toBe(400);
        expect(res.body).toEqual(TOO_OLD);
      } finally {
        await older.close();
      }
    });
  });
});
