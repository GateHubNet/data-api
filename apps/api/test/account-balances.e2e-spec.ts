import { Table } from '@gatehub/data-api-shared';
import { ApiClient, Harness, rippledError, startHarness } from './harness';
import { csvDisposition } from './support/csv';
import { Ledger, ledgerClock, liveNode, NodeRequest, trustLine } from './support/live-node';

/**
 * `GET /v2/accounts/:address/balances` on a real ClickHouse, with the live node replaced by a scripted stub
 * (`xrplStub`): the stub gets the exact request objects the app sends, so each test pins the commands and parameters
 * (`account_info`, then `account_lines` with `peer`, `limit` 400 and the `marker` of each page).
 *
 * Parity with `test.account.balances.js`: its one `it` ('get account balances') ran against a rippled that was not
 * there and expects the 500 `unable to retrieve balances`; it is ported unchanged, on a harness without a stub. The
 * original has nothing else (no test mocked rippled), so the rest is written from `accountBalances.js` and
 * `lib/rippled.js`, with the rulings of the task:
 *  - the default ledger is `validated` (the original asked for the open one), `ledger_hash` is forwarded (the original
 *    read it and ignored it), a `date` resolves to the last stored ledger closed at or before it;
 *  - `limit=all` pages every trust line (the original sent no limit); numeric limits are 200 by default and at most 400;
 *  - the native currency comes from the network profile (`XRP`, `XAH` on Xahau), converted from drops.
 *
 * The live cache is off (`GH_LIVE_CACHE_TTL_MS=0`) in the main block so that every request reaches the stub; its own
 * block runs with the default.
 */

const ACCOUNT = 'rHsZHqa5oMQNL5hFm4kfLd47aEMYjPstpg';
const GATEWAY = 'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B';
const OTHER_GATEWAY = 'rMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q';
const NOBODY = 'rrrrUBy92h6worVCYERZcVCzgzgmHb17Dx'; // checksum does not match: not an address
const HASH = 'BC79855472F0724120FD1196BE6C25E4EB74C4BEEAF5499F5BEECF65139ADF20';
const VALIDATED = 70_000_000;

const path = (account: string = ACCOUNT): string => `/v2/accounts/${account}/balances`;

const USD = trustLine('USD', GATEWAY, '12.5');
const EUR = trustLine('EUR', OTHER_GATEWAY, '-3');
const USD2 = trustLine('USD', OTHER_GATEWAY, '0.25');
const LINES = [USD, EUR, USD2];

const asBalance = (line: Record<string, unknown>): Record<string, unknown> => ({
  currency: line.currency,
  counterparty: line.account,
  value: line.balance,
});

/** What a node answers for `account_info` on the ledger the request names. */
function accountInfo(req: NodeRequest, balance = '100000000'): Record<string, unknown> {
  const current = req.ledger_index === 'current';
  return {
    account_data: { Account: req.account, Balance: balance, LedgerEntryType: 'AccountRoot' },
    ...(current
      ? { ledger_current_index: VALIDATED + 9, validated: false }
      : { ledger_index: typeof req.ledger_index === 'number' ? req.ledger_index : VALIDATED, validated: true }),
  };
}

/** A node with the account above: `account_info` and every trust line, on one page, honouring `peer`. */
function standardNode(req: NodeRequest): unknown {
  if (req.command === 'account_info') return accountInfo(req);
  if (req.command === 'account_lines') {
    const lines = req.peer === undefined ? LINES : LINES.filter((l) => l.account === req.peer);
    return { account: req.account, lines, ledger_index: req.ledger_index, validated: true };
  }
  throw new Error(`unexpected ${req.command}`);
}

interface Body {
  result: string;
  ledger_index?: number;
  close_time?: string;
  limit?: number;
  balances: Record<string, unknown>[];
}

describe('GET /v2/accounts/:address/balances', () => {
  describe('without a node (parity with test.account.balances.js)', () => {
    let h: Harness;
    beforeAll(async () => {
      h = await startHarness({ env: { GH_LIVE_CACHE_TTL_MS: '0' } });
    });
    afterAll(async () => {
      await h?.close();
    });

    it('get account balances', async () => {
      const api = await h.api();
      const res = await api.get(path());
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ result: 'error', message: 'unable to retrieve balances' });
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

    describe('the balances', () => {
      it('balances native first without counterparty', async () => {
        const res = await api.get(path());
        expect(res.status).toBe(200);
        expect(res.body).toEqual({
          result: 'success',
          ledger_index: VALIDATED,
          limit: 200,
          balances: [{ currency: 'XRP', value: '100' }, ...LINES.map(asBalance)],
        });
        const body = res.body as Body;
        // the keys come in the order of the original
        expect(Object.keys(body)).toEqual(['result', 'ledger_index', 'limit', 'balances']);
        expect(Object.keys(body.balances[0])).toEqual(['currency', 'value']);
        expect(Object.keys(body.balances[1])).toEqual(['currency', 'counterparty', 'value']);
        expect('counterparty' in body.balances[0]).toBe(false);
      });

      it('asks the node for account_info on the validated ledger, then for the trust lines of that very ledger', async () => {
        await api.get(path());
        expect(node.requests()).toEqual([
          { command: 'account_info', account: ACCOUNT, ledger_index: 'validated' },
          { command: 'account_lines', account: ACCOUNT, ledger_index: VALIDATED, limit: 400 },
        ]);
      });

      it('sends no api_version, and no peer or marker unless asked', async () => {
        await api.get(path());
        for (const req of node.requests()) {
          expect(req).not.toHaveProperty('api_version');
        }
        expect(node.requests('account_lines')[0]).not.toHaveProperty('peer');
        expect(node.requests('account_lines')[0]).not.toHaveProperty('marker');
      });

      it('an account without trust lines has the native balance only', async () => {
        node.serve((req) =>
          req.command === 'account_info' ? accountInfo(req, '20000000') : { account: ACCOUNT, lines: [] },
        );
        const res = await api.get(path());
        expect(res.body.balances).toEqual([{ currency: 'XRP', value: '20' }]);
      });

      it('converts the native balance from drops exactly', async () => {
        const balance = async (drops: string): Promise<unknown> => {
          node.serve((req) => (req.command === 'account_info' ? accountInfo(req, drops) : { lines: [] }));
          return (await api.get(path())).body.balances[0].value;
        };
        expect(await balance('0')).toBe('0');
        expect(await balance('1')).toBe('0.000001');
        expect(await balance('12345678')).toBe('12.345678');
        expect(await balance('99999999999999999')).toBe('99999999999.999999');
      });

      it('unknown params are ignored', async () => {
        const res = await api.get(`${path()}?foo=bar&marker=x&start=2013-01-01`);
        expect(res.status).toBe(200);
        expect((res.body as Body).balances).toHaveLength(4);
      });

      it('the first value of a repeated param wins', async () => {
        const res = await api.get(`${path()}?currency=USD&currency=EUR`);
        expect((res.body as Body).balances.map((b) => b.currency)).toEqual(['USD', 'USD']);
      });
    });

    describe('the ledger', () => {
      it('ledger_index is forwarded to account_info, and the lines are read from the ledger it answered with', async () => {
        const res = await api.get(`${path()}?ledger_index=${VALIDATED + 5}`);
        expect(res.body.ledger_index).toBe(VALIDATED + 5);
        expect(node.requests()).toEqual([
          { command: 'account_info', account: ACCOUNT, ledger_index: VALIDATED + 5 },
          { command: 'account_lines', account: ACCOUNT, ledger_index: VALIDATED + 5, limit: 400 },
        ]);
        expect('close_time' in res.body).toBe(false);
      });

      it('ledger is the alias of ledger_index, which wins when both are given and not empty', async () => {
        await api.get(`${path()}?ledger=11`);
        expect(node.requests('account_info')[0].ledger_index).toBe(11);
        node.serve(standardNode);
        await api.get(`${path()}?ledger_index=5&ledger=6`);
        expect(node.requests('account_info')[0].ledger_index).toBe(5);
        node.serve(standardNode);
        await api.get(`${path()}?ledger_index=&ledger=6`);
        expect(node.requests('account_info')[0].ledger_index).toBe(6);
      });

      it('ledger_index 0 is sent as it is (the node has no such ledger)', async () => {
        await api.get(`${path()}?ledger_index=0`);
        expect(node.requests('account_info')[0].ledger_index).toBe(0);
      });

      it('the node shortcuts validated, closed and current are accepted; current answers with its open ledger', async () => {
        for (const word of ['validated', 'closed']) {
          node.serve(standardNode);
          const res = await api.get(`${path()}?ledger_index=${word}`);
          expect(node.requests('account_info')[0].ledger_index).toBe(word);
          expect(res.body.ledger_index).toBe(VALIDATED);
        }
        node.serve(standardNode);
        const current = await api.get(`${path()}?ledger_index=current`);
        expect(current.body.ledger_index).toBe(VALIDATED + 9);
        expect(node.requests('account_lines')[0].ledger_index).toBe(VALIDATED + 9);
      });

      it('a ledger_index that is not a ledger number is ignored, as the original did (it sent NaN, the open ledger)', async () => {
        for (const junk of ['latest', '-1', '1.5', '1e3', 'abc', '99999999999', 'Validated']) {
          node.serve(standardNode);
          const res = await api.get(`${path()}?ledger_index=${junk}`);
          expect(res.status).toBe(200);
          expect(node.requests('account_info')[0]).toEqual({
            command: 'account_info',
            account: ACCOUNT,
            ledger_index: 'validated',
          });
        }
      });

      it('ledger_hash is forwarded, to the trust lines too: a hash names one ledger already', async () => {
        const res = await api.get(`${path()}?ledger_hash=${HASH}`);
        expect(res.status).toBe(200);
        expect(node.requests()).toEqual([
          { command: 'account_info', account: ACCOUNT, ledger_hash: HASH },
          { command: 'account_lines', account: ACCOUNT, ledger_hash: HASH, limit: 400 },
        ]);
        expect(res.body.ledger_index).toBe(VALIDATED);
      });

      it('ledger_hash is sent in upper case, and wins over ledger_index and date', async () => {
        await api.get(`${path()}?ledger_hash=${HASH.toLowerCase()}&ledger_index=5&date=2015-01-14T17:29:10Z`);
        expect(node.requests('account_info')).toEqual([
          { command: 'account_info', account: ACCOUNT, ledger_hash: HASH },
        ]);
      });

      it('an empty ledger_hash is none', async () => {
        await api.get(`${path()}?ledger_hash=&ledger_index=7`);
        expect(node.requests('account_info')[0]).toEqual({
          command: 'account_info',
          account: ACCOUNT,
          ledger_index: 7,
        });
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
        const between = from.close_time + 1; // `from` and `to` are neighbours at least 3 seconds apart
        const expected = clock.atOrBefore(between);
        const res = await api.get(`${path()}?date=${iso(between)}`);
        expect(res.status).toBe(200);
        expect(node.requests('account_info')).toEqual([
          { command: 'account_info', account: ACCOUNT, ledger_index: expected.ledger_index },
        ]);
        expect(res.body.ledger_index).toBe(expected.ledger_index);
        // the close time is the one of the ledger, not the date asked for
        expect(res.body.close_time).toBe(shown(expected.close_time));
        expect(expected.close_time).toBe(from.close_time);
        expect(Object.keys(res.body)).toEqual(['result', 'ledger_index', 'close_time', 'limit', 'balances']);

        // the very second a ledger closed is "at or before"
        node.serve(standardNode);
        const exact = await api.get(`${path()}?date=${iso(to.close_time)}`);
        expect(exact.body.ledger_index).toBe(clock.atOrBefore(to.close_time).ledger_index);
        expect(exact.body.close_time).toBe(shown(to.close_time));
        expect(exact.body.ledger_index).toBeGreaterThan(res.body.ledger_index);
      });

      it('date takes the formats of Ripple, close_time is its alias and wins when both are given', async () => {
        const { from, to } = clock;
        const viaUnix = await api.get(`${path()}?date=${to.close_time}`);
        expect(viaUnix.body.ledger_index).toBe(clock.atOrBefore(to.close_time).ledger_index);

        node.serve(standardNode);
        const alias = await api.get(`${path()}?close_time=${iso(from.close_time)}Z`);
        expect(alias.body.ledger_index).toBe(clock.atOrBefore(from.close_time).ledger_index);

        node.serve(standardNode);
        const both = await api.get(`${path()}?close_time=${iso(from.close_time)}&date=${iso(to.close_time)}`);
        expect(both.body.ledger_index).toBe(clock.atOrBefore(from.close_time).ledger_index);

        node.serve(standardNode);
        const empty = await api.get(`${path()}?close_time=&date=${iso(to.close_time)}`);
        expect(empty.body.ledger_index).toBe(clock.atOrBefore(to.close_time).ledger_index);
      });

      it('a date after the last ledger resolves to the last ledger stored', async () => {
        const res = await api.get(`${path()}?date=2099-01-01`);
        expect(res.body.ledger_index).toBe(clock.last.ledger_index);
        expect(res.body.close_time).toBe(shown(clock.last.close_time));
      });

      it('a date before the first ledger answers 400 the date provided is too old, without asking the node', async () => {
        const res = await api.get(`${path()}?date=2012-01-01`);
        expect(res.status).toBe(400);
        expect(res.body).toEqual({ result: 'error', message: 'the date provided is too old' });
        expect(node.requests()).toEqual([]);
        // the second before the first ledger closed is too old as well, the second it closed is not
        const justBefore = await api.get(`${path()}?date=${clock.first.close_time - 1}`);
        expect(justBefore.status).toBe(400);
        const exactly = await api.get(`${path()}?date=${clock.first.close_time}`);
        expect(exactly.status).toBe(200);
        expect(exactly.body.ledger_index).toBe(clock.atOrBefore(clock.first.close_time).ledger_index);
      });

      it('a date that is none answers 400 invalid date format', async () => {
        for (const bad of ['yesterday', '2015-13-01', '2015-02-30', '20150114']) {
          const res = await api.get(`${path()}?date=${bad}`);
          expect(res.status).toBe(400);
          expect(res.body).toEqual({ result: 'error', message: 'invalid date format' });
        }
        expect(node.requests()).toEqual([]);
      });

      it('date is checked even when a hash makes it unused, and a hash answers without close_time', async () => {
        const bad = await api.get(`${path()}?ledger_hash=${HASH}&date=nope`);
        expect(bad.status).toBe(400);
        expect(bad.body.message).toBe('invalid date format');

        const res = await api.get(`${path()}?ledger_hash=${HASH}&date=${iso(clock.from.close_time)}`);
        expect(res.status).toBe(200);
        expect('close_time' in res.body).toBe(false);
      });
    });

    describe('the filters', () => {
      it('currency keeps the trust lines of that currency, and drops the native balance', async () => {
        const res = await api.get(`${path()}?currency=USD`);
        expect(res.body.balances).toEqual([asBalance(USD), asBalance(USD2)]);
      });

      it('currency is compared as it is written: lower case matches nothing', async () => {
        const res = await api.get(`${path()}?currency=usd`);
        expect(res.status).toBe(200);
        expect(res.body.balances).toEqual([]);
      });

      it('currency of the native currency answers the native balance only, with no trust line request', async () => {
        const res = await api.get(`${path()}?currency=XRP`);
        expect(res.body).toEqual({
          result: 'success',
          ledger_index: VALIDATED,
          limit: 200,
          balances: [{ currency: 'XRP', value: '100' }],
        });
        expect(node.requests().map((r) => r.command)).toEqual(['account_info']);
      });

      it('counterparty is the peer of the trust line request, issuer is its alias, and the native balance stays', async () => {
        const res = await api.get(`${path()}?counterparty=${OTHER_GATEWAY}`);
        expect(node.requests('account_lines')).toEqual([
          { command: 'account_lines', account: ACCOUNT, ledger_index: VALIDATED, limit: 400, peer: OTHER_GATEWAY },
        ]);
        expect(res.body.balances).toEqual([{ currency: 'XRP', value: '100' }, asBalance(EUR), asBalance(USD2)]);

        node.serve(standardNode);
        const alias = await api.get(`${path()}?issuer=${GATEWAY}`);
        expect(node.requests('account_lines')[0].peer).toBe(GATEWAY);
        expect(alias.body.balances).toEqual([{ currency: 'XRP', value: '100' }, asBalance(USD)]);

        node.serve(standardNode);
        await api.get(`${path()}?counterparty=${GATEWAY}&issuer=${OTHER_GATEWAY}`);
        expect(node.requests('account_lines')[0].peer).toBe(GATEWAY);
      });

      it('currency and counterparty together', async () => {
        const res = await api.get(`${path()}?currency=USD&counterparty=${OTHER_GATEWAY}`);
        expect(res.body.balances).toEqual([asBalance(USD2)]);
      });

      it('an empty currency or counterparty is no filter', async () => {
        const res = await api.get(`${path()}?currency=&counterparty=&issuer=`);
        expect(res.body.balances).toHaveLength(4);
        expect(node.requests('account_lines')[0]).not.toHaveProperty('peer');
      });
    });

    describe('limit', () => {
      const pages: Record<string, { lines: unknown[]; marker?: string }> = {
        '': { lines: [EUR, EUR, USD], marker: 'm1' },
        m1: { lines: [USD2, EUR], marker: 'm2' },
        m2: { lines: [trustLine('USD', GATEWAY, '7'), trustLine('GBP', GATEWAY, '1')] },
      };
      /** A node whose trust lines come in three pages, each with the marker of the next. */
      const pagedNode = (req: NodeRequest): unknown => {
        if (req.command === 'account_info') return accountInfo(req);
        const page = pages[(req.marker as string | undefined) ?? ''];
        return { account: req.account, ledger_index: req.ledger_index, validated: true, ...page };
      };

      it('defaults to 200 and says so', async () => {
        const res = await api.get(path());
        expect(res.body.limit).toBe(200);
      });

      it('is at most 400, and says the 400', async () => {
        const res = await api.get(`${path()}?limit=1000`);
        expect(res.status).toBe(200);
        expect(res.body.limit).toBe(400);
      });

      it('counts the native balance: limit=2 is the native balance and the first trust line', async () => {
        const res = await api.get(`${path()}?limit=2`);
        expect(res.body.limit).toBe(2);
        expect(res.body.balances).toEqual([{ currency: 'XRP', value: '100' }, asBalance(USD)]);
      });

      it('limit=1 is the native balance alone and needs no trust lines', async () => {
        const res = await api.get(`${path()}?limit=1`);
        expect(res.body.balances).toEqual([{ currency: 'XRP', value: '100' }]);
        expect(node.requests().map((r) => r.command)).toEqual(['account_info']);
      });

      it('below one is the default, a decimal is cut (R33)', async () => {
        const limitOf = async (raw: string): Promise<unknown> => (await api.get(`${path()}?limit=${raw}`)).body.limit;
        expect(await limitOf('0')).toBe(200);
        expect(await limitOf('-3')).toBe(200);
        expect(await limitOf('')).toBe(200);
        expect(await limitOf('1.5')).toBe(1);
        expect(await limitOf('Infinity')).toBe(400);
        expect(await limitOf('1e3')).toBe(400);
      });

      it('a limit that is not a number answers 400 invalid limit, before any node request', async () => {
        node.serve(standardNode);
        for (const bad of ['abc', 'ALL', 'NaN', '12px']) {
          const res = await api.get(`${path()}?limit=${bad}`);
          expect(res.status).toBe(400);
          expect(res.body).toEqual({ result: 'error', message: 'invalid limit' });
        }
        expect(node.requests()).toEqual([]);
      });

      it('limit=all pages every trust line, 400 a page, each from the marker of the last, on the one ledger (R32)', async () => {
        node.serve(pagedNode);
        const res = await api.get(`${path()}?limit=all`);
        expect(res.status).toBe(200);
        expect(res.body.balances.map((b: Record<string, unknown>) => `${b.currency}:${b.value}`)).toEqual([
          'XRP:100',
          'EUR:-3',
          'EUR:-3',
          'USD:12.5',
          'USD:0.25',
          'EUR:-3',
          'USD:7',
          'GBP:1',
        ]);
        // no limit was sent, so none is said
        expect(Object.keys(res.body)).toEqual(['result', 'ledger_index', 'balances']);
        const lines = { command: 'account_lines', account: ACCOUNT, ledger_index: VALIDATED, limit: 400 };
        expect(node.requests('account_lines')).toEqual([lines, { ...lines, marker: 'm1' }, { ...lines, marker: 'm2' }]);
      });

      it('limit=all with a ledger_hash pages every trust line on that hash (M3)', async () => {
        node.serve(pagedNode);
        const res = await api.get(`${path()}?ledger_hash=${HASH}&limit=all`);
        expect(res.status).toBe(200);
        const lines = { command: 'account_lines', account: ACCOUNT, ledger_hash: HASH, limit: 400 };
        expect(node.requests('account_lines')).toEqual([lines, { ...lines, marker: 'm1' }, { ...lines, marker: 'm2' }]);
      });

      it('limit=all stops paging after 30 s in all and answers the route failure (R108)', async () => {
        const started = Date.now();
        let now = started;
        const clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
        try {
          node.serve((req) => {
            if (req.command === 'account_info') return accountInfo(req);
            // every page takes 11 s of the clock, and there are ten of them
            now += 11_000;
            const marker = Number(req.marker ?? 0) + 1;
            return {
              account: req.account,
              ledger_index: req.ledger_index,
              lines: [USD],
              ...(marker < 10 && { marker: String(marker) }),
            };
          });
          const res = await api.get(`${path()}?limit=all`);
          expect([res.status, res.body]).toEqual([500, { result: 'error', message: 'unable to retrieve balances' }]);
          // three pages are 33 s: the fourth is never asked for
          expect(node.requests('account_lines')).toHaveLength(3);
          expect(res.headers['cache-control']).toBe('no-store');
        } finally {
          clock.mockRestore();
        }
      });

      it('a numeric limit has no deadline of its own: it ends with the limit', async () => {
        node.serve(standardNode);
        const res = await api.get(`${path()}?limit=400`);
        expect(res.status).toBe(200);
      });

      it('limit=all with a marker that is an object passes it on unchanged', async () => {
        const marker = { ledger: 5, seq: 9 };
        node.serve((req) =>
          req.command === 'account_info'
            ? accountInfo(req)
            : req.marker === undefined
              ? { lines: [USD], marker }
              : { lines: [EUR] },
        );
        const res = await api.get(`${path()}?limit=all`);
        expect(res.body.balances).toHaveLength(3);
        expect(node.requests('account_lines')[1].marker).toEqual(marker);
      });

      it('a numeric limit stops paging as soon as it is filled', async () => {
        node.serve(pagedNode);
        const res = await api.get(`${path()}?limit=5`);
        expect(res.body.limit).toBe(5);
        expect(res.body.balances).toHaveLength(5);
        // native + 3 lines of the first page + the first of the second: two pages, not three
        expect(node.requests('account_lines')).toHaveLength(2);
      });

      it('a currency filter pages until the limit is filled with lines of that currency, not with the first page', async () => {
        node.serve(pagedNode);
        const res = await api.get(`${path()}?currency=USD&limit=3`);
        expect(res.body.balances.map((b: Record<string, unknown>) => b.value)).toEqual(['12.5', '0.25', '7']);
        expect(node.requests('account_lines')).toHaveLength(3);
      });

      it('limit=all with a currency filter reads every page', async () => {
        node.serve(pagedNode);
        const res = await api.get(`${path()}?currency=EUR&limit=all`);
        expect(res.body.balances).toHaveLength(3);
        expect(node.requests('account_lines')).toHaveLength(3);
      });

      it('a marker the node repeats ends in the route failure instead of a loop', async () => {
        node.serve((req) => (req.command === 'account_info' ? accountInfo(req) : { lines: [USD], marker: 'stuck' }));
        const res = await api.get(`${path()}?limit=all`);
        expect(res.status).toBe(500);
        expect(res.body).toEqual({ result: 'error', message: 'unable to retrieve balances' });
        expect(node.requests('account_lines').length).toBeLessThanOrEqual(3);
      });
    });

    describe('errors', () => {
      it('an address that is none answers 400 invalid ripple address, before anything else', async () => {
        for (const bad of [NOBODY, 'notanaddress', 'X7AcgcsBL6XDcUb289X4mJ8djcdyKaB5hJDWMArnXr61cqZ']) {
          const res = await api.get(`${path(bad)}?date=nope&limit=abc`);
          expect(res.status).toBe(400);
          expect(res.body).toEqual({ result: 'error', message: 'invalid ripple address' });
        }
        expect(node.requests()).toEqual([]);
      });

      it('the checks come in the order of the original: address, date, limit', async () => {
        const date = await api.get(`${path()}?date=nope&limit=abc`);
        expect(date.body.message).toBe('invalid date format');
        const limit = await api.get(`${path()}?limit=abc`);
        expect(limit.body.message).toBe('invalid limit');
      });

      it('actNotFound → 404', async () => {
        node.serve(() => {
          throw rippledError('actNotFound', 'Account not found.');
        });
        const res = await api.get(path());
        expect(res.status).toBe(404);
        expect(res.body).toEqual({ result: 'error', message: 'account not found' });
      });

      it('actNotFound on a later request is a 404 too', async () => {
        node.serve((req) => {
          if (req.command === 'account_info') return accountInfo(req);
          throw rippledError('actNotFound', 'Account not found.');
        });
        const res = await api.get(path());
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

      it('any other error of the node is the route failure: 500 unable to retrieve balances', async () => {
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
          expect(res.body).toEqual({ result: 'error', message: 'unable to retrieve balances' });
        }
      });

      it('an answer that is not an account (no account_data) is the route failure too', async () => {
        node.serve(() => ({ ledger_index: VALIDATED }));
        const res = await api.get(path());
        expect(res.status).toBe(500);
        expect(res.body.message).toBe('unable to retrieve balances');
      });
    });

    describe('format=csv', () => {
      it('answers the balances as a CSV file named after the account', async () => {
        const res = await api.get(`${path()}?format=csv`);
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/^text\/csv/);
        expect(res.headers['content-disposition']).toBe(csvDisposition(`${ACCOUNT} - balances`));
        expect(res.text.split('\n')).toEqual([
          '"currency","value","counterparty"',
          '"XRP","100",""',
          `"USD","12.5","${GATEWAY}"`,
          `"EUR","-3","${OTHER_GATEWAY}"`,
          `"USD","0.25","${OTHER_GATEWAY}"`,
        ]);
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
      expect(res.body.balances).toEqual([{ currency: 'XAH', value: '100' }, ...LINES.map(asBalance)]);
      expect('counterparty' in res.body.balances[0]).toBe(false);
    });

    it('currency of the native currency is XAH: it answers the native balance alone', async () => {
      const res = await api.get(`${path()}?currency=XAH`);
      expect(res.body.balances).toEqual([{ currency: 'XAH', value: '100' }]);
      expect(node.requests().map((r) => r.command)).toEqual(['account_info']);
    });

    it('XRP is no native currency there: it is a currency like any other, matched against the trust lines', async () => {
      node.serve((req) =>
        req.command === 'account_info' ? accountInfo(req) : { lines: [trustLine('XRP', GATEWAY, '4')] },
      );
      const res = await api.get(`${path()}?currency=XRP`);
      expect(res.body.balances).toEqual([{ currency: 'XRP', counterparty: GATEWAY, value: '4' }]);
    });

    it('the CSV has the native code', async () => {
      const res = await api.get(`${path()}?format=csv`);
      expect(res.text.split('\n')[1]).toBe('"XAH","100",""');
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
      // an error stays no-store
      expect((await api.get(`${path(a)}?limit=abc`)).headers['cache-control']).toBe('no-store');
    });

    it('an identical request is answered from the cache: the node is asked once', async () => {
      const a = freshAccount();
      const first = await api.get(`${path(a)}?limit=50`);
      const second = await api.get(`${path(a)}?limit=50`);
      expect(second.body).toEqual(first.body);
      expect(node.requests('account_info')).toHaveLength(1);
      expect(node.requests('account_lines')).toHaveLength(1);
    });

    it('the key is the whole resolved request: another limit, currency, counterparty, ledger or account asks again', async () => {
      const a = freshAccount();
      await api.get(path(a));
      const asked = (): number => node.requests('account_info').length;
      expect(asked()).toBe(1);
      for (const query of [
        '?limit=7',
        '?limit=all',
        '?currency=USD',
        `?counterparty=${GATEWAY}`,
        '?ledger_index=123',
        `?ledger_hash=${HASH}`,
        '?ledger_index=closed',
      ]) {
        const before = asked();
        await api.get(`${path(a)}${query}`);
        expect(asked()).toBe(before + 1);
        await api.get(`${path(a)}${query}`);
        expect(asked()).toBe(before + 1); // and that one is cached now
      }
      const before = asked();
      await api.get(path(GATEWAY));
      expect(asked()).toBe(before + 1);
    });

    it('limit=200 written out is the default request, limit=all another', async () => {
      const a = freshAccount();
      await api.get(path(a));
      await api.get(`${path(a)}?limit=200`);
      expect(node.requests('account_info')).toHaveLength(1);
      await api.get(`${path(a)}?limit=all`);
      expect(node.requests('account_info')).toHaveLength(2);
    });

    it('an error is not cached', async () => {
      const a = freshAccount();
      node.serve(() => {
        throw rippledError('actNotFound', 'Account not found.');
      });
      expect((await api.get(path(a))).status).toBe(404);
      node.serve(standardNode);
      const res = await api.get(path(a));
      expect(res.status).toBe(200);
      expect(node.requests('account_info')).toHaveLength(1);
    });

    it('dates that resolve to one ledger share an entry; close_time is the date route only, never taken from the entry', async () => {
      const a = freshAccount();
      const { from, to } = clock;
      const one = await api.get(`${path(a)}?date=${iso(from.close_time + 1)}`);
      const two = await api.get(`${path(a)}?date=${iso(to.close_time - 1)}`);
      expect(one.body.ledger_index).toBe(clock.atOrBefore(from.close_time).ledger_index);
      expect(two.body).toEqual(one.body);
      expect(node.requests('account_info')).toHaveLength(1);

      const plain = await api.get(`${path(a)}?ledger_index=${one.body.ledger_index}`);
      expect(node.requests('account_info')).toHaveLength(1);
      expect('close_time' in plain.body).toBe(false);
      expect('close_time' in one.body).toBe(true);
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
      expect(node.requests('account_info')).toHaveLength(2);
      // nothing is cached here, so nobody downstream may cache it either (R108)
      expect(res.headers['cache-control']).toBe('no-store');
    });
  });
});
