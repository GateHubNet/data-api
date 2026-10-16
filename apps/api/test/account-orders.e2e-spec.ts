import { Table } from '@gatehub/data-api-shared';
import { ApiClient, Harness, rippledError, startHarness } from './harness';
import { Ledger, ledgerClock, liveNode, nodeOffer, NodeRequest } from './support/live-node';

/**
 * `GET /v2/accounts/:address/orders` on a real ClickHouse, with the live node replaced by a scripted stub (`xrplStub`):
 * the stub gets the exact `account_offers` requests the app sends (ledger, `limit`, the `marker` of each page).
 *
 * Parity with `test.account.orders.js`: its one `it` ('get account orders') ran against a rippled that was not there
 * and expects the 500 `unable to retrieve orders`; it is ported unchanged, on a harness without a stub. The original
 * has nothing else, so the rest is written from `accountOrders.js` and `lib/rippled.js` (`getOrders`, `formatOrder`,
 * `adjustQualityForXRP`), with the rulings of the task:
 *  - the default ledger is `validated`, `ledger_hash` is forwarded, a `date` resolves to the last stored ledger closed
 *    at or before it (the original asked for the open ledger and ignored the hash);
 *  - `direction` is `sell` when the offer has the sell flag (0x00020000), else `buy` (the original always said `buy`,
 *    though it chose quantity and price by the real direction);
 *  - the native currency comes from the network profile (`XRP`, `XAH` on Xahau), converted from drops, and has no
 *    `counterparty`;
 *  - `limit=all` pages every offer (the original sent no limit then); numeric limits are 200 by default and at most 400.
 *
 * `currency` is read by the original and never used; here it is ignored too (see the test of that name).
 * The live cache is off (`GH_LIVE_CACHE_TTL_MS=0`) in the main block so that every request reaches the stub.
 */

const ACCOUNT = 'rHsZHqa5oMQNL5hFm4kfLd47aEMYjPstpg';
const GATEWAY = 'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B';
const OTHER_GATEWAY = 'rMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q';
const NOBODY = 'rrrrUBy92h6worVCYERZcVCzgzgmHb17Dx'; // checksum does not match: not an address
const HASH = 'BC79855472F0724120FD1196BE6C25E4EB74C4BEEAF5499F5BEECF65139ADF20';
const VALIDATED = 70_000_000;
const SELL = 0x00020000;
const PASSIVE = 0x00010000;

const path = (account: string = ACCOUNT): string => `/v2/accounts/${account}/orders`;

/** Pays 10 USD for 5 XRP: a buy of 10 USD, at 0.5 XRP each. Quality is TakerPays / TakerGets with XRP in drops. */
const BUY = nodeOffer({
  seq: 12,
  quality: '0.000002',
  taker_gets: '5000000',
  taker_pays: { currency: 'USD', issuer: GATEWAY, value: '10' },
});
const BUY_ORDER = {
  specification: {
    direction: 'buy',
    quantity: { currency: 'USD', value: '10', counterparty: GATEWAY },
    totalPrice: { currency: 'XRP', value: '5' },
  },
  properties: { maker: ACCOUNT, flags: 0, sequence: 12, makerExchangeRate: '2' },
};

/** Sells 20 USD for 10 XRP, with the sell flag. */
const SELL_OFFER = nodeOffer({
  flags: SELL,
  seq: 13,
  quality: '500000',
  taker_gets: { currency: 'USD', issuer: GATEWAY, value: '20' },
  taker_pays: '10000000',
});
const SELL_ORDER = {
  specification: {
    direction: 'sell',
    quantity: { currency: 'USD', value: '20', counterparty: GATEWAY },
    totalPrice: { currency: 'XRP', value: '10' },
  },
  properties: { maker: ACCOUNT, flags: SELL, sequence: 13, makerExchangeRate: '0.5' },
};

/** Gives 3 EUR for 6 USD, passive: no native side, so the quality is taken as it is. */
const IOU_OFFER = nodeOffer({
  flags: PASSIVE,
  seq: 14,
  quality: '2',
  taker_gets: { currency: 'EUR', issuer: OTHER_GATEWAY, value: '3' },
  taker_pays: { currency: 'USD', issuer: GATEWAY, value: '6' },
});
const IOU_ORDER = {
  specification: {
    direction: 'buy',
    quantity: { currency: 'USD', value: '6', counterparty: GATEWAY },
    totalPrice: { currency: 'EUR', value: '3', counterparty: OTHER_GATEWAY },
  },
  properties: { maker: ACCOUNT, flags: PASSIVE, sequence: 14, makerExchangeRate: '2' },
};

const OFFERS = [BUY, SELL_OFFER, IOU_OFFER];
const ORDERS = [BUY_ORDER, SELL_ORDER, IOU_ORDER];

interface Page {
  offers: unknown[];
  marker?: string;
}

/** A node whose `account_offers` come in the pages given, by the marker that asks for each (`''` for the first). */
function offersNode(pages: Record<string, Page>): (req: NodeRequest) => unknown {
  return (req) => {
    if (req.command !== 'account_offers') throw new Error(`unexpected ${req.command}`);
    const page = pages[(req.marker as string | undefined) ?? ''];
    if (!page) throw new Error(`unexpected marker ${String(req.marker)}`);
    const ledger =
      req.ledger_index === 'current'
        ? { ledger_current_index: VALIDATED + 9 }
        : { ledger_index: typeof req.ledger_index === 'number' ? req.ledger_index : VALIDATED, validated: true };
    return { account: req.account, ...ledger, ...page };
  };
}

const standardNode = offersNode({ '': { offers: OFFERS } });

interface Body {
  result: string;
  ledger_index?: number;
  close_time?: string;
  limit?: number;
  orders: Record<string, unknown>[];
}

describe('GET /v2/accounts/:address/orders', () => {
  describe('without a node (parity with test.account.orders.js)', () => {
    let h: Harness;
    beforeAll(async () => {
      h = await startHarness({ env: { GH_LIVE_CACHE_TTL_MS: '0' } });
    });
    afterAll(async () => {
      await h?.close();
    });

    it('get account orders', async () => {
      const api = await h.api();
      const res = await api.get(path());
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ result: 'error', message: 'unable to retrieve orders' });
    });
  });

  describe('against a scripted node (xrpl)', () => {
    let h: Harness;
    let api: ApiClient;
    const node = liveNode();
    let clock: ReturnType<typeof ledgerClock>;

    const iso = (seconds: number): string => new Date(seconds * 1000).toISOString().slice(0, 19);
    const shown = (seconds: number): string => `${iso(seconds)}Z`;

    beforeAll(async () => {
      h = await startHarness({ seed: 'ripple-mock', xrplStub: node.stub, env: { GH_LIVE_CACHE_TTL_MS: '0' } });
      api = await h.api();
      clock = ledgerClock(
        await h.ch.query<Ledger>(
          `SELECT ledger_index, toUnixTimestamp(close_time) AS close_time FROM ${Table.Ledgers} ORDER BY ledger_index`,
        ),
        3,
      );
    });
    afterAll(async () => {
      await h?.close();
    });
    beforeEach(() => node.serve(standardNode));

    describe('the orders', () => {
      it('lists the offers of the account as orders, in the order of the node', async () => {
        const res = await api.get(path());
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ result: 'success', ledger_index: VALIDATED, limit: 200, orders: ORDERS });
        expect(Object.keys(res.body)).toEqual(['result', 'ledger_index', 'limit', 'orders']);
      });

      it('asks the node for account_offers on the validated ledger, as many as the limit', async () => {
        await api.get(path());
        expect(node.requests()).toEqual([
          { command: 'account_offers', account: ACCOUNT, ledger_index: 'validated', limit: 200 },
        ]);
        expect(node.requests()[0]).not.toHaveProperty('api_version');
        expect(node.requests()[0]).not.toHaveProperty('marker');
      });

      it('the fields come in the order of the original, and the native side has no counterparty', async () => {
        const [buy, sell, iou] = (await api.get(path())).body.orders;
        expect(Object.keys(buy)).toEqual(['specification', 'properties']);
        expect(Object.keys(buy.specification)).toEqual(['direction', 'quantity', 'totalPrice']);
        expect(Object.keys(buy.specification.quantity)).toEqual(['currency', 'value', 'counterparty']);
        expect(Object.keys(buy.specification.totalPrice)).toEqual(['currency', 'value']);
        expect(Object.keys(buy.properties)).toEqual(['maker', 'flags', 'sequence', 'makerExchangeRate']);
        expect(Object.keys(sell.specification.totalPrice)).toEqual(['currency', 'value']);
        expect(Object.keys(iou.specification.totalPrice)).toEqual(['currency', 'value', 'counterparty']);
      });

      it('sell flag sets direction sell: the quantity is what is given, the total price what is asked', async () => {
        const res = await api.get(path());
        expect(res.body.orders[1]).toEqual(SELL_ORDER);
        expect(res.body.orders[1].specification.direction).toBe('sell');
      });

      it('an offer without the sell flag is a buy, whatever its other flags', async () => {
        const withFlags = (flags: number): Record<string, unknown> => ({ ...BUY, flags });
        node.serve(
          offersNode({
            '': {
              offers: [
                withFlags(PASSIVE),
                withFlags(0x00040000),
                withFlags(SELL | PASSIVE),
                withFlags(SELL | 0x00040000),
              ],
            },
          }),
        );
        const res = await api.get(path());
        const seen = res.body.orders.map(
          (o: { specification: { direction: string }; properties: { flags: number } }) => [
            o.properties.flags,
            o.specification.direction,
          ],
        );
        expect(seen).toEqual([
          [PASSIVE, 'buy'],
          [0x00040000, 'buy'],
          // the sell flag is 0x00020000: a sell with other flags is a sell
          [SELL | PASSIVE, 'sell'],
          [SELL | 0x00040000, 'sell'],
        ]);
      });

      it('the quality is adjusted for the drops of the native side, either side, and left alone for two tokens', async () => {
        const res = await api.get(path());
        // pays tokens, gets XRP: the quality counts XRP in drops in the denominator, 10^6 times too small
        expect(res.body.orders[0].properties.makerExchangeRate).toBe('2');
        // pays XRP, gets tokens: 10^6 too big
        expect(res.body.orders[1].properties.makerExchangeRate).toBe('0.5');
        expect(res.body.orders[2].properties.makerExchangeRate).toBe('2');
      });

      it('the quality is shifted exactly, and written the way BigNumber writes it', async () => {
        const offer = (quality: string, gets: unknown, pays: unknown) =>
          nodeOffer({ seq: 1, quality, taker_gets: gets, taker_pays: pays });
        const usd = { currency: 'USD', issuer: GATEWAY, value: '1' };
        node.serve(
          offersNode({
            '': {
              offers: [
                offer('0.0000000000123456789', '1000000', usd), // pays USD gets XRP: x 10^6
                offer('12345678901234567', usd, '1000000'), // pays XRP gets USD: x 10^-6
                offer('1e-7', '1000000', usd),
                offer('4.5e-9', usd, '1000000'),
              ],
            },
          }),
        );
        const res = await api.get(path());
        expect(
          res.body.orders.map((o: { properties: { makerExchangeRate: string } }) => o.properties.makerExchangeRate),
        ).toEqual(['0.0000123456789', '12345678901.234567', '0.1', '4.5e-15']);
      });

      it('an offer without a quality has no makerExchangeRate', async () => {
        node.serve(
          offersNode({ '': { offers: [{ flags: 0, seq: 1, taker_gets: '1000000', taker_pays: '2000000' }] } }),
        );
        const res = await api.get(path());
        expect(res.status).toBe(200);
        expect(Object.keys(res.body.orders[0].properties)).toEqual(['maker', 'flags', 'sequence']);
      });

      it('native amounts are converted from drops exactly', async () => {
        node.serve(
          offersNode({
            '': {
              offers: [
                nodeOffer({
                  seq: 1,
                  quality: '1',
                  taker_gets: '99999999999999999',
                  taker_pays: '1',
                }),
              ],
            },
          }),
        );
        const { specification } = (await api.get(path())).body.orders[0];
        expect(specification.quantity).toEqual({ currency: 'XRP', value: '0.000001' });
        expect(specification.totalPrice).toEqual({ currency: 'XRP', value: '99999999999.999999' });
      });

      it('an account without offers has no orders', async () => {
        node.serve(offersNode({ '': { offers: [] } }));
        const res = await api.get(path());
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ result: 'success', ledger_index: VALIDATED, limit: 200, orders: [] });
      });

      it('currency is read by the original and never used: it is ignored', async () => {
        const res = await api.get(`${path()}?currency=EUR`);
        expect(res.body.orders).toEqual(ORDERS);
        expect(node.requests()).toHaveLength(1);
      });

      it('unknown params are ignored', async () => {
        const res = await api.get(`${path()}?foo=bar&marker=x&counterparty=${GATEWAY}`);
        expect(res.status).toBe(200);
        expect(res.body.orders).toEqual(ORDERS);
        expect(node.requests()[0]).not.toHaveProperty('marker');
        expect(node.requests()[0]).not.toHaveProperty('peer');
      });
    });

    describe('the ledger', () => {
      it('ledger_index is forwarded, and the response says the ledger the node answered with', async () => {
        const res = await api.get(`${path()}?ledger_index=${VALIDATED + 5}`);
        expect(res.body.ledger_index).toBe(VALIDATED + 5);
        expect(node.requests()).toEqual([
          { command: 'account_offers', account: ACCOUNT, ledger_index: VALIDATED + 5, limit: 200 },
        ]);
        expect('close_time' in res.body).toBe(false);
      });

      it('ledger is the alias of ledger_index, which wins when both are given and not empty', async () => {
        await api.get(`${path()}?ledger=11`);
        expect(node.requests()[0].ledger_index).toBe(11);
        node.serve(standardNode);
        await api.get(`${path()}?ledger_index=5&ledger=6`);
        expect(node.requests()[0].ledger_index).toBe(5);
        node.serve(standardNode);
        await api.get(`${path()}?ledger_index=&ledger=6`);
        expect(node.requests()[0].ledger_index).toBe(6);
      });

      it('the node shortcuts are accepted; current answers with its open ledger', async () => {
        const closed = await api.get(`${path()}?ledger_index=closed`);
        expect(node.requests()[0].ledger_index).toBe('closed');
        expect(closed.body.ledger_index).toBe(VALIDATED);
        node.serve(standardNode);
        const current = await api.get(`${path()}?ledger_index=current`);
        expect(node.requests()[0].ledger_index).toBe('current');
        expect(current.body.ledger_index).toBe(VALIDATED + 9);
      });

      it('a ledger_index that is not a ledger number is ignored, as the original did', async () => {
        for (const junk of ['latest', '-1', '1.5', 'abc', '99999999999']) {
          node.serve(standardNode);
          const res = await api.get(`${path()}?ledger_index=${junk}`);
          expect(res.status).toBe(200);
          expect(node.requests()[0].ledger_index).toBe('validated');
        }
      });

      it('ledger_hash is forwarded', async () => {
        const res = await api.get(`${path()}?ledger_hash=${HASH}`);
        expect(res.status).toBe(200);
        expect(node.requests()).toEqual([
          { command: 'account_offers', account: ACCOUNT, ledger_hash: HASH, limit: 200 },
        ]);
        expect(res.body.ledger_index).toBe(VALIDATED);
      });

      it('ledger_hash is sent in upper case, and wins over ledger_index and date', async () => {
        await api.get(`${path()}?ledger_hash=${HASH.toLowerCase()}&ledger_index=5&date=2015-01-14T17:29:10Z`);
        expect(node.requests()).toEqual([
          { command: 'account_offers', account: ACCOUNT, ledger_hash: HASH, limit: 200 },
        ]);
      });

      it('a ledger_hash that is not 64 hex digits answers 400 invalid ledger hash, before any node request', async () => {
        for (const bad of ['abc', HASH.slice(1), `${HASH}0`, `${HASH.slice(1)}Z`]) {
          const res = await api.get(`${path()}?ledger_hash=${bad}`);
          expect(res.status).toBe(400);
          expect(res.body).toEqual({ result: 'error', message: 'invalid ledger hash' });
        }
        expect(node.requests()).toEqual([]);
      });

      it('date resolves to ledger at or before', async () => {
        const { from, to } = clock;
        const between = from.close_time + 1;
        const expected = clock.atOrBefore(between);
        const res = await api.get(`${path()}?date=${iso(between)}`);
        expect(res.status).toBe(200);
        expect(node.requests()).toEqual([
          { command: 'account_offers', account: ACCOUNT, ledger_index: expected.ledger_index, limit: 200 },
        ]);
        expect(res.body.ledger_index).toBe(expected.ledger_index);
        expect(res.body.close_time).toBe(shown(expected.close_time));
        expect(Object.keys(res.body)).toEqual(['result', 'ledger_index', 'close_time', 'limit', 'orders']);

        node.serve(standardNode);
        const exact = await api.get(`${path()}?close_time=${iso(to.close_time)}`);
        expect(exact.body.ledger_index).toBe(clock.atOrBefore(to.close_time).ledger_index);
        expect(exact.body.close_time).toBe(shown(to.close_time));
      });

      it('a date before the first ledger answers 400 the date provided is too old, without asking the node', async () => {
        const res = await api.get(`${path()}?date=2012-01-01`);
        expect(res.status).toBe(400);
        expect(res.body).toEqual({ result: 'error', message: 'the date provided is too old' });
        expect(node.requests()).toEqual([]);
      });

      it('a date after the last ledger resolves to the last ledger stored', async () => {
        const res = await api.get(`${path()}?date=2099-01-01`);
        expect(res.body.ledger_index).toBe(clock.last.ledger_index);
      });

      it('a date that is none answers 400 invalid date format', async () => {
        for (const bad of ['yesterday', '2015-13-01', '2015-02-30']) {
          const res = await api.get(`${path()}?date=${bad}`);
          expect(res.status).toBe(400);
          expect(res.body).toEqual({ result: 'error', message: 'invalid date format' });
        }
        expect(node.requests()).toEqual([]);
      });
    });

    describe('limit', () => {
      /** Offers numbered by their sequence. */
      const offers = (...seqs: number[]): unknown[] => seqs.map((seq) => ({ ...BUY, seq }));
      const sequences = (body: Body): unknown[] =>
        body.orders.map((o) => (o.properties as { sequence: number }).sequence);

      it('defaults to 200 and says so', async () => {
        expect((await api.get(path())).body.limit).toBe(200);
      });

      it('is at most 400, and says the 400', async () => {
        const res = await api.get(`${path()}?limit=1000`);
        expect(res.body.limit).toBe(400);
        expect(node.requests()[0].limit).toBe(400);
      });

      it('asks for as many offers as the limit', async () => {
        await api.get(`${path()}?limit=25`);
        expect(node.requests()[0]).toEqual({
          command: 'account_offers',
          account: ACCOUNT,
          ledger_index: 'validated',
          limit: 25,
        });
      });

      it('below one is the default, a decimal is cut (R33)', async () => {
        const limitOf = async (raw: string): Promise<unknown> => (await api.get(`${path()}?limit=${raw}`)).body.limit;
        expect(await limitOf('0')).toBe(200);
        expect(await limitOf('-3')).toBe(200);
        expect(await limitOf('')).toBe(200);
        expect(await limitOf('2.9')).toBe(2);
        expect(await limitOf('Infinity')).toBe(400);
      });

      it('a limit that is not a number answers 400 invalid limit, before any node request', async () => {
        for (const bad of ['abc', 'ALL', 'NaN', '12px']) {
          const res = await api.get(`${path()}?limit=${bad}`);
          expect(res.status).toBe(400);
          expect(res.body).toEqual({ result: 'error', message: 'invalid limit' });
        }
        expect(node.requests()).toEqual([]);
      });

      it('a numeric limit pages until it is filled: the rest of the limit is asked for, on the ledger of the first page', async () => {
        node.serve(
          offersNode({
            '': { offers: offers(1, 2), marker: 'm1' },
            m1: { offers: offers(3, 4), marker: 'm2' },
            m2: { offers: offers(5) },
          }),
        );
        const res = await api.get(`${path()}?limit=3`);
        expect(sequences(res.body)).toEqual([1, 2, 3]);
        expect(res.body.limit).toBe(3);
        expect(node.requests()).toEqual([
          { command: 'account_offers', account: ACCOUNT, ledger_index: 'validated', limit: 3 },
          { command: 'account_offers', account: ACCOUNT, ledger_index: VALIDATED, limit: 1, marker: 'm1' },
        ]);
      });

      it('a node that answers more than asked for is cut to the limit', async () => {
        node.serve(offersNode({ '': { offers: offers(1, 2, 3, 4, 5), marker: 'm1' } }));
        const res = await api.get(`${path()}?limit=2`);
        expect(sequences(res.body)).toEqual([1, 2]);
        expect(node.requests()).toHaveLength(1);
      });

      it('limit=all pages every offer, 400 a page, each from the marker of the last, on the one ledger (R32)', async () => {
        node.serve(
          offersNode({
            '': { offers: offers(1, 2), marker: 'm1' },
            m1: { offers: offers(3, 4), marker: 'm2' },
            m2: { offers: offers(5) },
          }),
        );
        const res = await api.get(`${path()}?limit=all`);
        expect(res.status).toBe(200);
        expect(sequences(res.body)).toEqual([1, 2, 3, 4, 5]);
        // no limit was sent, so none is said
        expect(Object.keys(res.body)).toEqual(['result', 'ledger_index', 'orders']);
        const next = { command: 'account_offers', account: ACCOUNT, limit: 400 };
        expect(node.requests()).toEqual([
          { ...next, ledger_index: 'validated' },
          { ...next, ledger_index: VALIDATED, marker: 'm1' },
          { ...next, ledger_index: VALIDATED, marker: 'm2' },
        ]);
      });

      it('a hash names one ledger already: every page is asked of it (M3)', async () => {
        node.serve(
          offersNode({
            '': { offers: offers(1), marker: 'm1' },
            m1: { offers: offers(2) },
          }),
        );
        await api.get(`${path()}?ledger_hash=${HASH}&limit=all`);
        expect(node.requests()).toEqual([
          { command: 'account_offers', account: ACCOUNT, ledger_hash: HASH, limit: 400 },
          { command: 'account_offers', account: ACCOUNT, ledger_hash: HASH, limit: 400, marker: 'm1' },
        ]);
      });

      it('limit=all stops paging after 30 s in all and answers the route failure (R108)', async () => {
        let now = Date.now();
        const clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
        try {
          node.serve((req) => {
            // every page takes 11 s of the clock, and there are ten of them
            now += 11_000;
            const marker = Number(req.marker ?? 0) + 1;
            if (marker >= 10)
              return { account: req.account, ledger_index: VALIDATED, validated: true, offers: offers(marker) };
            return {
              account: req.account,
              ledger_index: VALIDATED,
              validated: true,
              offers: offers(marker),
              marker: String(marker),
            };
          });
          const res = await api.get(`${path()}?limit=all`);
          expect([res.status, res.body]).toEqual([500, { result: 'error', message: 'unable to retrieve orders' }]);
          expect(node.requests()).toHaveLength(3);
          expect(res.headers['cache-control']).toBe('no-store');
        } finally {
          clock.mockRestore();
        }
      });

      it('limit=all with a marker that is an object passes it on unchanged', async () => {
        const marker = { ledger: 5, seq: 9 };
        node.serve((req) =>
          req.marker === undefined
            ? { offers: offers(1), marker, ledger_index: VALIDATED }
            : { offers: offers(2), ledger_index: VALIDATED },
        );
        const res = await api.get(`${path()}?limit=all`);
        expect(sequences(res.body)).toEqual([1, 2]);
        expect(node.requests()[1].marker).toEqual(marker);
      });

      it('the response says the ledger of the first page, which the pages after it are asked for', async () => {
        node.serve((req) =>
          req.marker === undefined
            ? { offers: offers(1), marker: 'm1', ledger_index: 11 }
            : req.marker === 'm1'
              ? { offers: offers(2), marker: 'm2', ledger_index: 11 }
              : { offers: offers(3), ledger_index: 11 },
        );
        const res = await api.get(`${path()}?limit=all`);
        expect(res.body.ledger_index).toBe(11);
        expect(node.requests().map((r) => r.ledger_index)).toEqual(['validated', 11, 11]);
      });

      it('a marker the node repeats ends in the route failure instead of a loop', async () => {
        node.serve(() => ({ offers: offers(1), marker: 'stuck', ledger_index: VALIDATED }));
        const res = await api.get(`${path()}?limit=all`);
        expect(res.status).toBe(500);
        expect(res.body).toEqual({ result: 'error', message: 'unable to retrieve orders' });
        expect(node.requests().length).toBeLessThanOrEqual(3);
      });
    });

    describe('errors', () => {
      it('an address that is none answers 400 invalid ripple address (the original asked the node, which failed), before anything else', async () => {
        for (const bad of [NOBODY, 'notanaddress', 'X7AcgcsBL6XDcUb289X4mJ8djcdyKaB5hJDWMArnXr61cqZ']) {
          const res = await api.get(`${path(bad)}?date=nope&limit=abc`);
          expect(res.status).toBe(400);
          expect(res.body).toEqual({ result: 'error', message: 'invalid ripple address' });
        }
        expect(node.requests()).toEqual([]);
      });

      it('the checks come in the order of the original: address, date, limit', async () => {
        expect((await api.get(`${path()}?date=nope&limit=abc`)).body.message).toBe('invalid date format');
        expect((await api.get(`${path()}?limit=abc`)).body.message).toBe('invalid limit');
      });

      it('actNotFound → 404', async () => {
        node.serve(() => {
          throw rippledError('actNotFound', 'Account not found.');
        });
        const res = await api.get(path());
        expect(res.status).toBe(404);
        expect(res.body).toEqual({ result: 'error', message: 'account not found' });
      });

      it('actNotFound on a later page is a 404 too', async () => {
        node.serve((req) => {
          if (req.marker === undefined) return { offers: [BUY], marker: 'm1', ledger_index: VALIDATED };
          throw rippledError('actNotFound', 'Account not found.');
        });
        const res = await api.get(`${path()}?limit=all`);
        expect(res.status).toBe(404);
        expect(res.body.message).toBe('account not found');
      });

      it('lgrNotFound → 400 the date provided is too old, whatever named the ledger', async () => {
        node.serve(() => {
          throw rippledError('lgrNotFound', 'ledgerNotFound');
        });
        for (const query of ['', '?ledger_index=5', `?ledger_hash=${HASH}`, `?date=${iso(clock.from.close_time)}`]) {
          const res = await api.get(`${path()}${query}`);
          expect(res.status).toBe(400);
          expect(res.body).toEqual({ result: 'error', message: 'the date provided is too old' });
        }
      });

      it('any other error of the node is the route failure: 500 unable to retrieve orders', async () => {
        for (const err of [
          rippledError('actMalformed', 'Account malformed.'),
          rippledError('invalidParams', 'Invalid field.'),
          rippledError('tooBusy', 'The server is too busy to help you now.'),
          new Error('socket hang up'),
          Object.assign(new Error('No node connection within 10000 ms'), { name: 'NotConnectedError' }),
        ]) {
          node.serve(() => {
            throw err;
          });
          const res = await api.get(path());
          expect(res.status).toBe(500);
          expect(res.body).toEqual({ result: 'error', message: 'unable to retrieve orders' });
        }
      });

      it('an answer that holds no offers array is the route failure too', async () => {
        node.serve(() => ({ ledger_index: VALIDATED }));
        const res = await api.get(path());
        expect(res.status).toBe(500);
        expect(res.body.message).toBe('unable to retrieve orders');
      });
    });

    describe('format=csv', () => {
      it('answers the orders as a flat CSV file named after the account', async () => {
        const res = await api.get(`${path()}?format=csv`);
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/^text\/csv/);
        expect(res.headers['content-disposition']).toBe(`attachment; filename=${ACCOUNT} - orders.csv`);
        const lines = res.text.split('\n');
        expect(lines[0]).toBe(
          [
            'specification.direction',
            'specification.quantity.currency',
            'specification.quantity.value',
            'specification.quantity.counterparty',
            'specification.totalPrice.currency',
            'specification.totalPrice.value',
            'properties.maker',
            'properties.flags',
            'properties.sequence',
            'properties.makerExchangeRate',
            'specification.totalPrice.counterparty',
          ]
            .map((c) => `"${c}"`)
            .join(','),
        );
        expect(lines[1]).toBe(
          ['buy', 'USD', '10', GATEWAY, 'XRP', '5', ACCOUNT, '0', '12', '2', ''].map((c) => `"${c}"`).join(','),
        );
        expect(lines).toHaveLength(1 + ORDERS.length);
      });

      it('format is case-insensitive, and anything but csv is JSON', async () => {
        expect((await api.get(`${path()}?format=CSV`)).headers['content-type']).toMatch(/^text\/csv/);
        expect((await api.get(`${path()}?format=xml`)).headers['content-type']).toMatch(/^application\/json/);
      });

      it('an error stays JSON', async () => {
        const res = await api.get(`${path(NOBODY)}?format=csv`);
        expect(res.status).toBe(400);
        expect(res.headers['content-type']).toMatch(/^application\/json/);
      });
    });
  });

  describe('Xahau', () => {
    let h: Harness;
    let api: ApiClient;
    const node = liveNode();
    beforeAll(async () => {
      h = await startHarness({ network: 'xahau', xrplStub: node.stub, env: { GH_LIVE_CACHE_TTL_MS: '0' } });
      api = await h.api();
    });
    afterAll(async () => {
      await h?.close();
    });
    beforeEach(() => node.serve(standardNode));

    it('Xahau shows XAH', async () => {
      const res = await api.get(path());
      expect(res.status).toBe(200);
      const [buy, sell, iou] = res.body.orders;
      expect(buy.specification.totalPrice).toEqual({ currency: 'XAH', value: '5' });
      expect(sell.specification.totalPrice).toEqual({ currency: 'XAH', value: '10' });
      expect('counterparty' in buy.specification.totalPrice).toBe(false);
      // the quality is adjusted for the native side by what the amount is (drops), not by the name of the currency
      expect(buy.properties.makerExchangeRate).toBe('2');
      expect(sell.properties.makerExchangeRate).toBe('0.5');
      // tokens named XRP are tokens there
      expect(iou.specification.quantity.currency).toBe('USD');
    });

    it('an XRP token is a token on Xahau, with its issuer', async () => {
      node.serve(
        offersNode({
          '': {
            offers: [
              nodeOffer({
                seq: 1,
                quality: '3',
                taker_gets: { currency: 'XRP', issuer: GATEWAY, value: '1' },
                taker_pays: { currency: 'USD', issuer: GATEWAY, value: '3' },
              }),
            ],
          },
        }),
      );
      const [order] = (await api.get(path())).body.orders;
      expect(order.specification.totalPrice).toEqual({ currency: 'XRP', value: '1', counterparty: GATEWAY });
      expect(order.properties.makerExchangeRate).toBe('3');
    });
  });

  describe('the live cache (default TTL)', () => {
    let h: Harness;
    let api: ApiClient;
    const node = liveNode();
    let clock: ReturnType<typeof ledgerClock>;
    const iso = (seconds: number): string => new Date(seconds * 1000).toISOString().slice(0, 19);

    beforeAll(async () => {
      h = await startHarness({ seed: 'ripple-mock', xrplStub: node.stub });
      api = await h.api();
      clock = ledgerClock(
        await h.ch.query<Ledger>(
          `SELECT ledger_index, toUnixTimestamp(close_time) AS close_time FROM ${Table.Ledgers} ORDER BY ledger_index`,
        ),
        5,
      );
    });
    afterAll(async () => {
      await h?.close();
    });
    beforeEach(() => node.serve(standardNode));

    // every test has an account of its own: the cache lives as long as the app
    const ACCOUNTS = [
      'rpjZUBy92h6worVCYERZcVCzgzgmHb17Dx',
      'rGcSxmn1ibh5ZfCMAEu2iy7mnrb5nE6fbY',
      'rBeToNo4AwHaNbRX2n4BNCYKtpTyFLQwkj',
      'rUeXUxaMTH1pELvD2EkiHTRcM9FsH3v4d7',
      'rK5j9n8baXfL4gzUoZsfxBvvsv97P5swaV',
      'rHsZHqa5oMQNL5hFm4kfLd47aEMYjPstpg',
    ];
    let used = 0;
    const freshAccount = (): string => {
      // a test that ran out of accounts would share another test's cache entry (M4)
      if (used >= ACCOUNTS.length) throw new Error('add an account to ACCOUNTS: every test needs one of its own');
      return ACCOUNTS[used++];
    };

    it('a live answer is private and no older than the live cache: max-age of the TTL in seconds, JSON and CSV (R108)', async () => {
      const a = freshAccount();
      for (const query of ['', '?format=csv']) {
        const res = await api.get(`${path(a)}${query}`);
        expect([query, res.status, res.headers['cache-control']]).toEqual([query, 200, 'private, max-age=10']);
      }
      expect((await api.get(`${path(a)}?limit=abc`)).headers['cache-control']).toBe('no-store');
    });

    it('an identical request is answered from the cache: the node is asked once', async () => {
      const a = freshAccount();
      const first = await api.get(`${path(a)}?limit=50`);
      const second = await api.get(`${path(a)}?limit=50`);
      expect(second.body).toEqual(first.body);
      expect(node.requests()).toHaveLength(1);
    });

    it('the key is the whole resolved request: another limit, ledger or account asks again', async () => {
      const a = freshAccount();
      await api.get(path(a));
      for (const query of [
        '?limit=7',
        '?limit=all',
        '?ledger_index=123',
        `?ledger_hash=${HASH}`,
        '?ledger_index=closed',
      ]) {
        const before = node.requests().length;
        await api.get(`${path(a)}${query}`);
        expect(node.requests().length).toBe(before + 1);
        await api.get(`${path(a)}${query}`);
        expect(node.requests().length).toBe(before + 1);
      }
      const before = node.requests().length;
      await api.get(path(GATEWAY));
      expect(node.requests().length).toBe(before + 1);
    });

    it('an error is not cached', async () => {
      const a = freshAccount();
      node.serve(() => {
        throw rippledError('actNotFound', 'Account not found.');
      });
      expect((await api.get(path(a))).status).toBe(404);
      node.serve(standardNode);
      expect((await api.get(path(a))).status).toBe(200);
      expect(node.requests()).toHaveLength(1);
    });

    it('dates that resolve to one ledger share an entry; close_time is the date route only, never taken from the entry', async () => {
      const a = freshAccount();
      const { from, to } = clock;
      const one = await api.get(`${path(a)}?date=${iso(from.close_time + 1)}`);
      const two = await api.get(`${path(a)}?date=${iso(to.close_time - 1)}`);
      expect(two.body).toEqual(one.body);
      expect(node.requests()).toHaveLength(1);
      const plain = await api.get(`${path(a)}?ledger_index=${one.body.ledger_index}`);
      expect(node.requests()).toHaveLength(1);
      expect('close_time' in plain.body).toBe(false);
      expect('close_time' in one.body).toBe(true);
    });

    it('a cached answer is not changed by the response built from it', async () => {
      const a = freshAccount();
      const first = await api.get(`${path(a)}?format=csv`);
      const second = await api.get(`${path(a)}`);
      expect(first.headers['content-type']).toMatch(/^text\/csv/);
      expect(second.body.orders).toEqual(ORDERS);
      expect(node.requests()).toHaveLength(1);
    });
  });

  describe('the live cache off (GH_LIVE_CACHE_TTL_MS=0)', () => {
    let h: Harness;
    const node = liveNode();
    beforeAll(async () => {
      h = await startHarness({ xrplStub: node.stub, env: { GH_LIVE_CACHE_TTL_MS: '0' } });
    });
    afterAll(async () => {
      await h?.close();
    });

    it('asks the node every time', async () => {
      node.serve(standardNode);
      const api = await h.api();
      await api.get(path());
      const res = await api.get(path());
      expect(node.requests()).toHaveLength(2);
      // nothing is cached here, so nobody downstream may cache it either (R108)
      expect(res.headers['cache-control']).toBe('no-store');
    });
  });
});
