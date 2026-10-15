import { LedgersRow, RawLedger, Table } from '@gatehub/data-api-shared';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Harness, startHarness } from './harness';
import { BinaryTx, fixtureSource, RIPPLE_MOCK_DIR, transactionTreeRoot } from './support/fixtures';

/**
 * `GET /v2/ledgers[/:ledger_param]` and `GET /v2/last_validated` on a real ClickHouse, seeded with the 54 ledgers of
 * the original Ripple test suite (`ripple-mock`).
 *
 * Ported from rippled-historical-database `test/test.ledgers.js` (all nine `it`s, same titles; its expectations all
 * come from the mock ledgers). Nothing is skipped. Added: the identifier rules, the shape of the ledger object, the
 * transaction modes, the failure paths and `/v2/last_validated` (which the original has no test for).
 */

const MOCK: RawLedger[] = [...fixtureSource('ripple-mock').list()].sort(
  (a, b) => a.header.ledger_index - b.header.ledger_index,
);
const BY_INDEX = new Map(MOCK.map((l) => [l.header.ledger_index, l]));
/**
 * The ledgers as rippled served them. The original stored the whole ledger (`accepted`, `closed`, `hash`, `seqNum` and
 * `totalCoins` too) and `close_time_human` there is the format of the Ripple API (`2015-Jan-14 18:27:00`).
 */
interface RawMockLedger {
  ledger_index: string;
  close_time_human: string;
  accepted: boolean;
  closed: boolean;
  hash: string;
  seqNum: string;
  totalCoins: string;
}
const RAW = new Map(
  readdirSync(RIPPLE_MOCK_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(RIPPLE_MOCK_DIR, f), 'utf8')) as RawMockLedger)
    .map((l) => [Number(l.ledger_index), l]),
);
const LATEST = MOCK[MOCK.length - 1].header;
/** Unix seconds of an ISO time; one without a zone is UTC (`Date.parse` would read it as local time). */
const unix = (iso: string): number => Date.parse(/(Z|[+-]\d\d:\d\d)$/.test(iso) ? iso : `${iso}Z`) / 1000;

/** The highest index among the mock ledgers that closed at or before `iso`. */
function atOrBefore(iso: string): number | undefined {
  const closed = MOCK.filter((l) => l.header.close_time <= unix(iso)).map((l) => l.header.ledger_index);
  return closed.length === 0 ? undefined : Math.max(...closed);
}

/**
 * The ledger object the Ripple API serves for a mock ledger (without `transactions`). The five leftovers of the raw
 * ledger are what HBase gave back for them: it stores `JSON.stringify(value)` and returns text, so the booleans
 * `accepted` and `closed` are the strings "true".
 */
function expectedLedger(index: number): Record<string, unknown> {
  const { header } = BY_INDEX.get(index) as RawLedger;
  const raw = RAW.get(index) as RawMockLedger;
  return {
    ledger_hash: header.ledger_hash,
    ledger_index: header.ledger_index,
    parent_hash: header.parent_hash,
    total_coins: header.total_coins,
    close_time: header.close_time,
    close_time_human: raw.close_time_human,
    close_time_resolution: String(header.close_time_resolution),
    close_flags: String(header.close_flags),
    ...(header.parent_close_time > 0 && { parent_close_time: header.parent_close_time }),
    account_hash: header.account_hash,
    transaction_hash: header.transaction_hash,
    hash: raw.hash,
    seqNum: raw.seqNum,
    totalCoins: raw.totalCoins,
    accepted: JSON.stringify(raw.accepted),
    closed: JSON.stringify(raw.closed),
  };
}

const KEY_ORDER = [
  'ledger_hash',
  'ledger_index',
  'parent_hash',
  'total_coins',
  'close_time',
  'close_time_human',
  'close_time_resolution',
  'close_flags',
  'parent_close_time',
  'account_hash',
  'transaction_hash',
  'hash',
  'seqNum',
  'totalCoins',
  'accepted',
  'closed',
  'transactions',
];

const LEDGER_11119599 = 'B5931AD267E59306769309AFF13FCCD55C2EF944E99228C8F2EEEC5D3B49234D';
const MOCK_PAYMENT = '22F26CE4E2270CE3CF4EB61C609E7ADEDCD41D4C1BA2D96D680A9B016C4F47DA';

function api(h: Harness) {
  return (path: string) => h.http().get(path).set('X-API-Key', h.key);
}

describe('ledgers API endpoint', () => {
  let h: Harness;
  let get: ReturnType<typeof api>;
  beforeAll(async () => {
    h = await startHarness({ seed: 'ripple-mock' });
    get = api(h);
  });
  afterAll(async () => {
    await h?.close();
  });

  // -- test.ledgers.js ------------------------------------------------------------------------------------------

  it('should return the latest ledger: /ledgers', async () => {
    const res = await get('/v2/ledgers');
    expect(res.status).toBe(200);
    expect(typeof res.body).toBe('object');
    expect(res.body.result).toBe('success');
    expect(typeof res.body.ledger).toBe('object');
    expect(res.body.ledger.ledger_index).toBe(29709909);
    expect(res.body.ledger.transactions).toBeUndefined();
  });

  it('should return ledgers by ledger index', async () => {
    const res = await get('/v2/ledgers/11119599');
    expect(res.status).toBe(200);
    expect(res.body.result).toBe('success');
    expect(typeof res.body.ledger).toBe('object');
    expect(res.body.ledger.ledger_index).toBe(11119599);
    expect(res.body.ledger.transactions).toBeUndefined();
  });

  it('should return an error if the ledger is not found', async () => {
    const res = await get('/v2/ledgers/20000');
    expect(res.status).toBe(404);
    expect(typeof res.body).toBe('object');
    expect(res.body.result).toBe('error');
    expect(res.body.message).toBe('ledger not found');
  });

  it('should return ledgers by ledger hash', async () => {
    const res = await get('/v2/ledgers/b5931ad267e59306769309aff13fccd55c2ef944e99228c8f2eeec5d3b49234d');
    expect(res.status).toBe(200);
    expect(res.body.result).toBe('success');
    expect(typeof res.body.ledger).toBe('object');
    expect(res.body.ledger.ledger_hash).toBe(LEDGER_11119599);
    expect(res.body.ledger.transactions).toBeUndefined();
  });

  it('should return an error if the hash is invald', async () => {
    const res = await get('/v2/ledgers/b59');
    expect(res.status).toBe(400);
    expect(typeof res.body).toBe('object');
    expect(res.body.result).toBe('error');
    expect(res.body.message).toBe('invalid ledger identifier');
  });

  it('should return ledgers by date: /ledgers/:date', async () => {
    const res = await get('/v2/ledgers/2015-01-14T17:43:10');
    expect(res.status).toBe(200);
    expect(res.body.result).toBe('success');
    expect(typeof res.body.ledger).toBe('object');
    expect(res.body.ledger.transactions).toBeUndefined();
    // 11119015 is the ledger that closed at exactly 17:43:10
    expect(res.body.ledger.ledger_index).toBe(11119015);
  });

  it('should include transaction hashes', async () => {
    const res = await get('/v2/ledgers?transactions=true');
    expect(typeof res.body.ledger.transactions).toBe('object');
    expect(res.body.ledger.transactions).toHaveLength(61);
    for (const hash of res.body.ledger.transactions) {
      expect(typeof hash).toBe('string');
      expect(hash).toHaveLength(64);
    }
  });

  it('should include transaction json with expand=true', async () => {
    const res = await get('/v2/ledgers?expand=true');
    expect(typeof res.body.ledger.transactions).toBe('object');
    expect(res.body.ledger.transactions).toHaveLength(61);
    for (const tx of res.body.ledger.transactions) {
      expect(typeof tx).toBe('object');
      expect(typeof tx.tx).toBe('object');
      expect(typeof tx.meta).toBe('object');
      expect(typeof tx.hash).toBe('string');
      expect(typeof tx.date).toBe('string');
      expect(typeof tx.ledger_index).toBe('number');
    }
  });

  it('should include transaction binary with binary=true', async () => {
    const res = await get('/v2/ledgers?binary=true');
    expect(typeof res.body.ledger.transactions).toBe('object');
    expect(res.body.ledger.transactions).toHaveLength(61);
    for (const tx of res.body.ledger.transactions) {
      expect(typeof tx).toBe('object');
      expect(typeof tx.tx).toBe('string');
      expect(typeof tx.meta).toBe('string');
      expect(typeof tx.hash).toBe('string');
      expect(typeof tx.date).toBe('string');
      expect(typeof tx.ledger_index).toBe('number');
    }
  });

  // -- the identifier ---------------------------------------------------------------------------------------------

  describe('identifier', () => {
    it('2015 is treated as a ledger index', async () => {
      // As a year it would be "the ledger closed at or before 2015-12-31", which is a mock ledger; as an index no
      // ledger has it.
      expect(atOrBefore('2015-12-31T23:59:59Z')).toBeDefined();
      const res = await get('/v2/ledgers/2015');
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ result: 'error', message: 'ledger not found' });
    });

    it('a number is the ledger index even when it looks like a date (YYYYMMDDHHmmss, unix seconds)', async () => {
      for (const digits of ['20150114174310', '1421257390']) {
        const res = await get(`/v2/ledgers/${digits}`);
        expect(res.status).toBe(404);
        expect(res.body).toEqual({ result: 'error', message: 'ledger not found' });
      }
    });

    it('serves the ledger of every mock index', async () => {
      for (const index of BY_INDEX.keys()) {
        const res = await get(`/v2/ledgers/${index}`);
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ result: 'success', ledger: expectedLedger(index) });
      }
    });

    it('odd-length hex → 400 invalid ledger identifier', async () => {
      for (const id of ['b59', LEDGER_11119599.slice(1), 'ABCDE']) {
        const res = await get(`/v2/ledgers/${id}`);
        expect(res.status).toBe(400);
        expect(res.body).toEqual({ result: 'error', message: 'invalid ledger identifier' });
      }
    });

    it('something that is no index, hash or date → 400 invalid ledger identifier', async () => {
      for (const id of ['latest', 'xyz', '2015-13-45', '2015-01-14T25:00:00', '-5', '1.5']) {
        const res = await get(`/v2/ledgers/${id}`);
        expect(res.status).toBe(400);
        expect(res.body).toEqual({ result: 'error', message: 'invalid ledger identifier' });
      }
    });

    it('missing → 404 ledger not found', async () => {
      const unknownHash = 'AB'.repeat(32);
      const targets = [
        '/v2/ledgers/20000', // an index below the first ledger
        '/v2/ledgers/99999999', // an index above the last one
        '/v2/ledgers/0',
        '/v2/ledgers/99999999999999999999', // too large for any ledger index
        `/v2/ledgers/${unknownHash}`,
        `/v2/ledgers/${unknownHash.toLowerCase()}`,
        '/v2/ledgers/2012-01-01T00:00:00', // before the first ledger
        '/v2/ledgers?ledger_index=20000',
        `/v2/ledgers?ledger_hash=${unknownHash}`,
        '/v2/ledgers?date=2012-01-01',
      ];
      for (const target of targets) {
        const res = await get(target);
        expect([target, res.status, res.body]).toEqual([target, 404, { result: 'error', message: 'ledger not found' }]);
      }
    });

    it('a hash is found in either case', async () => {
      for (const hash of [LEDGER_11119599, LEDGER_11119599.toLowerCase()]) {
        const res = await get(`/v2/ledgers/${hash}`);
        expect(res.status).toBe(200);
        expect(res.body.ledger.ledger_index).toBe(11119599);
        expect(res.body.ledger.ledger_hash).toBe(LEDGER_11119599);
      }
    });

    it('the 0x prefix is accepted as hex but is no part of any hash: 404', async () => {
      const res = await get(`/v2/ledgers/0x${LEDGER_11119599.slice(2)}`);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ result: 'error', message: 'ledger not found' });
    });

    it('no identifier → the latest committed ledger', async () => {
      const res = await get('/v2/ledgers');
      expect(res.body).toEqual({ result: 'success', ledger: expectedLedger(LATEST.ledger_index) });
      expect((await get('/v2/ledgers/')).body.ledger.ledger_index).toBe(LATEST.ledger_index);
    });
  });

  describe('date', () => {
    it('is the ledger that closed at or before it', async () => {
      // 11118861 closed at 17:31:40, 11119015 at 17:43:10, 11119599 at 18:27:00
      const cases: [string, number][] = [
        ['2015-01-14T17:43:10', 11119015],
        ['2015-01-14T17:43:10Z', 11119015],
        ['2015-01-14T17:43:11', 11119015],
        ['2015-01-14T17:43:09', 11118861],
        ['2015-01-14T18:26:59', 11119015],
        ['2015-01-14T18:27:00', 11119599],
        ['2015-01-14T17:29:10', 11118827],
        ['2015-01-14T17:29:09', 2964124], // the last ledger of 2013 is the one before 11118827
      ];
      for (const [date, expected] of cases) {
        const res = await get(`/v2/ledgers/${date}`);
        expect([date, res.status, res.body.ledger?.ledger_index]).toEqual([date, 200, expected]);
        expect(expected).toBe(atOrBefore(date));
      }
    });

    it('among ledgers that closed in the same second, the highest index', async () => {
      // 11119600 and 11119601 both closed at 18:27:10
      const res = await get('/v2/ledgers/2015-01-14T18:27:10');
      expect(res.body.ledger.ledger_index).toBe(11119601);
    });

    it('a date with less than a second is the whole period it names', async () => {
      // lib/hbase/hbase-thrift/data.js: the scan ends one unit of the date's precision after it
      const cases: [string, string][] = [
        ['/v2/ledgers/2015-01-14', '2015-01-14T23:59:59'],
        ['/v2/ledgers/2015-01-14T18:27', '2015-01-14T18:27:59'],
        ['/v2/ledgers/2015-01-14T18', '2015-01-14T18:59:59'],
        ['/v2/ledgers/2015-01', '2015-01-31T23:59:59'],
        // a year is only a year as the query: in the path it is a ledger index
        ['/v2/ledgers?date=2014', '2014-12-31T23:59:59'],
        ['/v2/ledgers?date=2015', '2015-12-31T23:59:59'],
        ['/v2/ledgers?date=2015-01-14', '2015-01-14T23:59:59'],
      ];
      for (const [target, lastSecond] of cases) {
        const expected = atOrBefore(lastSecond);
        expect(expected).toBeDefined();
        const res = await get(target);
        expect([target, res.status, res.body.ledger?.ledger_index]).toEqual([target, 200, expected]);
      }
      // pinned: the last mock ledger of the day, and of the minute 18:27
      expect((await get('/v2/ledgers/2015-01-14')).body.ledger.ledger_index).toBe(11120176);
      expect((await get('/v2/ledgers/2015-01-14T18:27')).body.ledger.ledger_index).toBe(11119609);
      expect((await get('/v2/ledgers?date=2014')).body.ledger.ledger_index).toBe(2964124);
    });

    it('a date with an offset is converted to UTC', async () => {
      const res = await get('/v2/ledgers/2015-01-14T18:43:10%2B01:00');
      expect(res.status).toBe(200);
      expect(res.body.ledger.ledger_index).toBe(11119015);
    });

    it('a date after the last ledger is the latest ledger', async () => {
      const res = await get('/v2/ledgers/2030-01-01');
      expect(res.status).toBe(200);
      expect(res.body.ledger.ledger_index).toBe(LATEST.ledger_index);
    });

    it('the ledger of the date has the ledger object of that ledger', async () => {
      const res = await get('/v2/ledgers/2015-01-14T17:43:10');
      expect(res.body).toEqual({ result: 'success', ledger: expectedLedger(11119015) });
    });
  });

  describe('query alternatives', () => {
    it('ledger_index', async () => {
      const res = await get('/v2/ledgers?ledger_index=11119599');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ result: 'success', ledger: expectedLedger(11119599) });
    });

    it('ledger_hash, in either case', async () => {
      for (const hash of [LEDGER_11119599, LEDGER_11119599.toLowerCase()]) {
        const res = await get(`/v2/ledgers?ledger_hash=${hash}`);
        expect(res.status).toBe(200);
        expect(res.body.ledger.ledger_index).toBe(11119599);
      }
    });

    it('date', async () => {
      const res = await get('/v2/ledgers?date=2015-01-14T17:43:10');
      expect(res.status).toBe(200);
      expect(res.body.ledger.ledger_index).toBe(11119015);
    });

    it('an invalid date → 400 invalid date format', async () => {
      for (const date of ['yesterday', '2015-02-30', '2015-01-14T25:00:00']) {
        const res = await get(`/v2/ledgers?date=${date}`);
        expect([date, res.status, res.body]).toEqual([date, 400, { result: 'error', message: 'invalid date format' }]);
      }
    });

    it('the path identifier replaces ledger_index, and ignores date', async () => {
      expect((await get('/v2/ledgers/11119599?ledger_index=11118827')).body.ledger.ledger_index).toBe(11119599);
      expect((await get('/v2/ledgers/11119599?date=nonsense')).body.ledger.ledger_index).toBe(11119599);
    });

    it('ledger_hash beats a date, and a date beats ledger_index', async () => {
      const byHash = await get(
        `/v2/ledgers?ledger_hash=${LEDGER_11119599}&date=2015-01-14T17:43:10&ledger_index=11118827`,
      );
      expect(byHash.body.ledger.ledger_index).toBe(11119599);
      const byDate = await get('/v2/ledgers?date=2015-01-14T17:43:10&ledger_index=11118827');
      expect(byDate.body.ledger.ledger_index).toBe(11119015);
      const byHashOverPath = await get(`/v2/ledgers/11118827?ledger_hash=${LEDGER_11119599}`);
      expect(byHashOverPath.body.ledger.ledger_index).toBe(11119599);
    });

    it('an empty alternative is no alternative', async () => {
      const res = await get('/v2/ledgers?ledger_index=&ledger_hash=&date=');
      expect(res.status).toBe(200);
      expect(res.body.ledger.ledger_index).toBe(LATEST.ledger_index);
    });

    it('a ledger_index that is not a whole number finds no ledger: 404', async () => {
      for (const bad of ['abc', '-1', '1.5', '1e3']) {
        const res = await get(`/v2/ledgers?ledger_index=${bad}`);
        expect([bad, res.status, res.body]).toEqual([bad, 404, { result: 'error', message: 'ledger not found' }]);
      }
    });

    it('a repeated parameter counts with its first value', async () => {
      const res = await get('/v2/ledgers?ledger_index=11119599&ledger_index=11118827');
      expect(res.body.ledger.ledger_index).toBe(11119599);
    });

    it('unknown params ignored', async () => {
      const res = await get('/v2/ledgers/11119599?foo=bar&limit=3&format=csv');
      expect(res.status).toBe(200);
      expect(res.body.ledger.ledger_index).toBe(11119599);
    });
  });

  // -- the ledger object ------------------------------------------------------------------------------------------

  describe('ledger object', () => {
    it('has the fields of the Ripple API, in this order', async () => {
      const res = await get('/v2/ledgers/11618225?transactions=true');
      expect(Object.keys(res.body)).toEqual(['result', 'ledger']);
      expect(Object.keys(res.body.ledger)).toEqual(KEY_ORDER);
    });

    it('numbers: ledger_index, close_time (unix seconds), parent_close_time', async () => {
      const { ledger } = (await get('/v2/ledgers/11618225')).body;
      expect(ledger.ledger_index).toBe(11618225);
      expect(ledger.close_time).toBe(476829000 + 946684800);
      expect(ledger.parent_close_time).toBe(476828990 + 946684800);
    });

    it('strings: hashes, total_coins, close_time_human, close_time_resolution, close_flags', async () => {
      const { ledger } = (await get('/v2/ledgers/11618225')).body;
      expect(ledger).toMatchObject({
        ledger_hash: expect.stringMatching(/^[0-9A-F]{64}$/),
        parent_hash: expect.stringMatching(/^[0-9A-F]{64}$/),
        account_hash: expect.stringMatching(/^[0-9A-F]{64}$/),
        transaction_hash: expect.stringMatching(/^[0-9A-F]{64}$/),
        total_coins: expect.stringMatching(/^\d+$/),
        close_time_human: expect.stringMatching(/^\d{4}-[A-Z][a-z]{2}-\d\d \d\d:\d\d:\d\d$/),
        close_time_resolution: '10',
        close_flags: '0',
      });
    });

    it('the leftovers of the raw ledger are served as text: hash, seqNum, totalCoins, accepted, closed', async () => {
      // The original stored the whole ledger in HBase, which keeps JSON.stringify(value) and returns text: the
      // numbers stay digits and the booleans are "true". They follow transaction_hash and carry nothing new.
      const { ledger } = (await get('/v2/ledgers/11119599')).body;
      expect(ledger.hash).toBe(ledger.ledger_hash);
      expect(ledger.seqNum).toBe('11119599');
      expect(ledger.totalCoins).toBe(ledger.total_coins);
      expect(ledger.accepted).toBe('true');
      expect(ledger.closed).toBe('true');
      for (const field of ['hash', 'seqNum', 'totalCoins', 'accepted', 'closed']) {
        expect([field, typeof ledger[field]]).toEqual([field, 'string']);
      }
      expect(Object.keys(ledger).slice(-5)).toEqual(['hash', 'seqNum', 'totalCoins', 'accepted', 'closed']);
    });

    it('the leftovers are the same as the raw mock ledgers have, for every mock ledger', async () => {
      for (const index of BY_INDEX.keys()) {
        const raw = RAW.get(index) as RawMockLedger;
        const { ledger } = (await get(`/v2/ledgers/${index}`)).body;
        expect([index, ledger.hash, ledger.seqNum, ledger.totalCoins, ledger.accepted, ledger.closed]).toEqual([
          index,
          raw.hash,
          raw.seqNum,
          raw.totalCoins,
          'true',
          'true',
        ]);
      }
    });

    it('the leftovers sit between transaction_hash and transactions', async () => {
      const { ledger } = (await get('/v2/ledgers/11119599?transactions=true')).body;
      expect(Object.keys(ledger).slice(-6)).toEqual([
        'hash',
        'seqNum',
        'totalCoins',
        'accepted',
        'closed',
        'transactions',
      ]);
    });

    it('total_coins keeps every digit', async () => {
      const { ledger } = (await get('/v2/ledgers/29709909')).body;
      expect(ledger.total_coins).toBe('99994758814182467');
      expect(ledger.totalCoins).toBe('99994758814182467');
      expect(typeof ledger.total_coins).toBe('string');
    });

    it('close_time_human is the close time in UTC: 2015-Jan-14 18:27:00', async () => {
      expect((await get('/v2/ledgers/11119599')).body.ledger.close_time_human).toBe('2015-Jan-14 18:27:00');
      expect((await get('/v2/ledgers/29709909')).body.ledger.close_time_human).toBe('2017-May-12 14:48:52');
    });

    it('parent_close_time is left out where the ledger has none', async () => {
      const without = (await get('/v2/ledgers/11119599')).body.ledger;
      expect(without).not.toHaveProperty('parent_close_time');
      expect(Object.keys(without)).toEqual(KEY_ORDER.filter((k) => k !== 'parent_close_time' && k !== 'transactions'));
      expect(await get('/v2/ledgers/29709909').then((r) => r.body.ledger.parent_close_time)).toBe(
        547915731 + 946684800,
      );
    });
  });

  // -- transactions -----------------------------------------------------------------------------------------------

  describe('transactions', () => {
    const hashesOf = (index: number) => (BY_INDEX.get(index) as RawLedger).transactions.map((t) => t.hash);

    it('transactions=true lists the hashes in transaction order', async () => {
      for (const index of [11119599, 11119619, 11120009, 29709909]) {
        const res = await get(`/v2/ledgers/${index}?transactions=true`);
        expect(res.body.ledger.transactions).toEqual(hashesOf(index));
      }
    });

    it('transactions=true adds nothing else to the ledger object', async () => {
      const res = await get('/v2/ledgers/11119599?transactions=true');
      const { transactions, ...ledger } = res.body.ledger;
      expect(transactions).toHaveLength(19);
      expect(ledger).toEqual(expectedLedger(11119599));
    });

    it('the flags are tested like Ripple does: /true/i', async () => {
      expect((await get('/v2/ledgers/11119599?transactions=TRUE')).body.ledger.transactions).toHaveLength(19);
      expect((await get('/v2/ledgers/11119599?transactions=1')).body.ledger.transactions).toBeUndefined();
      expect((await get('/v2/ledgers/11119599?transactions=false')).body.ledger.transactions).toBeUndefined();
      expect((await get('/v2/ledgers/11119599?transactions=')).body.ledger.transactions).toBeUndefined();
      expect((await get('/v2/ledgers/11119599?expand=True')).body.ledger.transactions[0].tx).toBeInstanceOf(Object);
    });

    it('expand=true gives the transaction objects, without ledger_hash, in transaction order', async () => {
      const res = await get('/v2/ledgers/11119599?expand=true');
      const txs = res.body.ledger.transactions;
      expect(txs.map((t: { hash: string }) => t.hash)).toEqual(hashesOf(11119599));
      for (const [i, tx] of txs.entries()) {
        expect(Object.keys(tx)).toEqual(['hash', 'ledger_index', 'date', 'tx', 'meta']);
        expect(tx.ledger_index).toBe(11119599);
        expect(tx.date).toBe('2015-01-14T18:27:00+00:00');
        expect(tx.meta.TransactionIndex).toBe(i);
        expect(tx.tx.TransactionType).toBe(BY_INDEX.get(11119599)?.transactions[i].tx.TransactionType);
        expect(tx.meta.TransactionResult).toBe(BY_INDEX.get(11119599)?.transactions[i].meta.TransactionResult);
      }
    });

    it('expand=true adds the delivered_amount of a successful payment, as the transaction endpoints do', async () => {
      // the payment of test.transactions.js
      const ledger = MOCK.find((l) => l.transactions.some((t) => t.hash === MOCK_PAYMENT));
      expect(ledger).toBeDefined();
      const res = await get(`/v2/ledgers/${ledger?.header.ledger_index}?expand=true`);
      const tx = res.body.ledger.transactions.find((t: { hash: string }) => t.hash === MOCK_PAYMENT);
      expect(tx.meta.delivered_amount).toBe('300000000');
    });

    it('expand=true on the whole ledger has the transaction count and the transaction hashes of the ledger', async () => {
      for (const [index, ledger] of BY_INDEX) {
        const res = await get(`/v2/ledgers/${index}?expand=true`);
        expect(res.body.ledger.transactions).toHaveLength(ledger.transactions.length);
        expect(res.body.ledger.transactions.map((t: { hash: string }) => t.hash)).toEqual(
          ledger.transactions.map((t) => t.hash),
        );
      }
    });

    it('binary=true gives hex strings, which rebuild the transaction_hash of the ledger', async () => {
      for (const index of BY_INDEX.keys()) {
        const res = await get(`/v2/ledgers/${index}?binary=true`);
        const { transactions, transaction_hash } = res.body.ledger as {
          transactions: BinaryTx[];
          transaction_hash: string;
        };
        expect(transactions).toHaveLength(BY_INDEX.get(index)?.transactions.length as number);
        for (const tx of transactions as unknown as Record<string, unknown>[]) {
          expect(Object.keys(tx)).toEqual(['hash', 'ledger_index', 'date', 'tx', 'meta']);
          expect(tx.tx).toMatch(/^[0-9A-F]+$/);
          expect(tx.meta).toMatch(/^[0-9A-F]+$/);
        }
        expect([index, transactionTreeRoot(transactions)]).toEqual([index, transaction_hash]);
      }
    });

    it('binary wins over expand', async () => {
      const both = await get('/v2/ledgers/11119599?binary=true&expand=true');
      const binary = await get('/v2/ledgers/11119599?binary=true');
      expect(both.status).toBe(200);
      expect(both.body.ledger.transactions).toHaveLength(19);
      for (const tx of both.body.ledger.transactions) {
        expect(typeof tx.tx).toBe('string');
        expect(typeof tx.meta).toBe('string');
      }
      expect(both.body).toEqual(binary.body);
    });

    it('binary and expand win over transactions', async () => {
      for (const flags of ['binary=true&transactions=true', 'expand=true&transactions=true']) {
        const res = await get(`/v2/ledgers/11119599?${flags}`);
        expect([flags, typeof res.body.ledger.transactions[0]]).toEqual([flags, 'object']);
      }
    });

    it('the transactions of an expanded ledger are the same objects in either order of the flags', async () => {
      const a = await get('/v2/ledgers/11119599?expand=true&transactions=true');
      const b = await get('/v2/ledgers/11119599?transactions=true&expand=true');
      expect(a.body).toEqual(b.body);
    });

    it('is the same on the latest ledger', async () => {
      const res = await get('/v2/ledgers?transactions=true');
      expect(res.body.ledger.transactions).toEqual(hashesOf(LATEST.ledger_index));
    });
  });

  describe('authentication', () => {
    it('both routes need the API key', async () => {
      for (const path of ['/v2/ledgers', '/v2/ledgers/11119599', '/v2/last_validated']) {
        const res = await h.http().get(path);
        expect([path, res.status]).toEqual([path, 401]);
      }
    });
  });

  // -- /v2/last_validated -----------------------------------------------------------------------------------------

  describe('/v2/last_validated', () => {
    it('is the newest committed ledger', async () => {
      const res = await get('/v2/last_validated');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        result: 'success',
        ledger_index: '29709909',
        ledger_hash: LATEST.ledger_hash,
        parent_hash: LATEST.parent_hash,
        close_time: '2017-05-12T14:48:52Z',
      });
    });

    it('has the fields of the original, in this order', async () => {
      const res = await get('/v2/last_validated');
      expect(Object.keys(res.body)).toEqual(['result', 'ledger_index', 'ledger_hash', 'parent_hash', 'close_time']);
    });

    it('ledger_index is a string, as the original read it from its control row', async () => {
      const res = await get('/v2/last_validated');
      expect(res.body.ledger_index).toBe(String(LATEST.ledger_index));
      expect(typeof res.body.ledger_index).toBe('string');
    });

    it('close_time is YYYY-MM-DDTHH:mm:ssZ', async () => {
      const res = await get('/v2/last_validated');
      expect(res.body.close_time).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
      expect(Date.parse(res.body.close_time) / 1000).toBe(LATEST.close_time);
    });

    it('agrees with /v2/ledgers', async () => {
      const [last, latest] = await Promise.all([get('/v2/last_validated'), get('/v2/ledgers')]);
      expect(last.body.ledger_index).toBe(String(latest.body.ledger.ledger_index));
      expect(last.body.ledger_hash).toBe(latest.body.ledger.ledger_hash);
      expect(last.body.parent_hash).toBe(latest.body.ledger.parent_hash);
    });

    it('unknown params ignored', async () => {
      expect((await get('/v2/last_validated?foo=bar')).status).toBe(200);
    });
  });
});

describe('ledgers API endpoint on an empty database', () => {
  let h: Harness;
  let get: ReturnType<typeof api>;
  beforeAll(async () => {
    h = await startHarness();
    get = api(h);
  });
  afterAll(async () => {
    await h?.close();
  });

  it('there is no latest ledger: 404 ledger not found', async () => {
    const res = await get('/v2/ledgers');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ result: 'error', message: 'ledger not found' });
  });

  it('no ledger by index, hash or date', async () => {
    for (const path of ['/v2/ledgers/11119599', `/v2/ledgers/${LEDGER_11119599}`, '/v2/ledgers/2015-01-14T17:43:10']) {
      const res = await get(path);
      expect([path, res.status, res.body]).toEqual([path, 404, { result: 'error', message: 'ledger not found' }]);
    }
  });

  it('/v2/last_validated has nothing to answer: 500 unavailable (the original never answered)', async () => {
    const res = await get('/v2/last_validated');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ result: 'error', message: 'unavailable' });
  });
});

/** The ledger after the last mock ledger. */
const NEXT = LATEST.ledger_index + 1;

/** A `ledgers` row (the commit marker) for a ledger that is not in the fixtures: `NEXT`, without transactions. */
const headerRow = (over: Partial<LedgersRow> = {}): LedgersRow => ({
  ledger_index: NEXT,
  ledger_hash: 'C'.repeat(64),
  parent_hash: LATEST.ledger_hash,
  account_hash: 'D'.repeat(64),
  transaction_hash: 'E'.repeat(64),
  total_coins: '99994758814182467',
  close_time: LATEST.close_time + 4,
  parent_close_time: LATEST.close_time,
  close_time_resolution: 10,
  close_flags: 0,
  tx_count: 0,
  type_counts: {},
  result_counts: {},
  payments_count: 0,
  exchanges_count: 0,
  accounts_created: 0,
  fee_total: '0',
  fee_min: '0',
  fee_max: '0',
  parser_version: 1,
  ...over,
});

/** Commits a ledger the way the syncer does: the lookup row first, the `ledgers` row (the commit marker) last. */
async function commit(h: Harness, row: LedgersRow): Promise<void> {
  await h.ch.insert(Table.LedgerByHash, [{ ledger_hash: row.ledger_hash, ledger_index: row.ledger_index }]);
  await h.ch.insert(Table.Ledgers, [row]);
}

describe('ledgers API endpoint on committed and uncommitted data', () => {
  let h: Harness;
  let get: ReturnType<typeof api>;
  beforeAll(async () => {
    h = await startHarness({ seed: 'ripple-mock' });
    get = api(h);
    // The newest ledger of this describe: committed, 'C...' by hash, no transactions.
    await commit(h, headerRow());
  });
  afterAll(async () => {
    await h?.close();
  });

  it('a ledger_by_hash row without a ledgers row is no ledger yet', async () => {
    const hash = 'A1'.repeat(32);
    await h.ch.insert(Table.LedgerByHash, [{ ledger_hash: hash, ledger_index: NEXT + 1 }]);
    for (const id of [hash, String(NEXT + 1)]) {
      const res = await get(`/v2/ledgers/${id}`);
      expect([id, res.status, res.body]).toEqual([id, 404, { result: 'error', message: 'ledger not found' }]);
    }
    expect((await get('/v2/ledgers')).body.ledger.ledger_index).toBe(NEXT);
  });

  it('a ledger_by_hash row of another ledger does not give that ledger under this hash', async () => {
    const wrong = 'B2'.repeat(32);
    await h.ch.insert(Table.LedgerByHash, [{ ledger_hash: wrong, ledger_index: 11119599 }]);
    const res = await get(`/v2/ledgers/${wrong}`);
    expect(res.status).toBe(404);
  });

  it('the commit marker makes the ledger the latest, for /v2/ledgers and /v2/last_validated', async () => {
    const latest = await get('/v2/ledgers');
    expect(latest.body.ledger).toEqual({
      ledger_hash: 'C'.repeat(64),
      ledger_index: NEXT,
      parent_hash: LATEST.ledger_hash,
      total_coins: '99994758814182467',
      close_time: LATEST.close_time + 4,
      close_time_human: '2017-May-12 14:48:56',
      close_time_resolution: '10',
      close_flags: '0',
      parent_close_time: LATEST.close_time,
      account_hash: 'D'.repeat(64),
      transaction_hash: 'E'.repeat(64),
      hash: 'C'.repeat(64),
      seqNum: String(NEXT),
      totalCoins: '99994758814182467',
      accepted: 'true',
      closed: 'true',
    });
    expect((await get(`/v2/ledgers/${'c'.repeat(64)}`)).body.ledger.ledger_index).toBe(NEXT);
    expect((await get('/v2/last_validated')).body).toEqual({
      result: 'success',
      ledger_index: String(NEXT),
      ledger_hash: 'C'.repeat(64),
      parent_hash: LATEST.ledger_hash,
      close_time: '2017-05-12T14:48:56Z',
    });
  });

  it('an empty ledger has no transactions key unless transactions=true (expand and binary find nothing to expand)', async () => {
    // getLedger.js: expand / binary only apply to a ledger that has transactions; transactions=true lists them
    expect((await get(`/v2/ledgers/${NEXT}`)).body.ledger).not.toHaveProperty('transactions');
    for (const flags of ['expand=true', 'binary=true', 'expand=true&binary=true']) {
      const res = await get(`/v2/ledgers/${NEXT}?${flags}`);
      expect([flags, res.status]).toEqual([flags, 200]);
      expect(res.body.ledger).not.toHaveProperty('transactions');
    }
    for (const flags of ['transactions=true', 'transactions=true&expand=true', 'transactions=true&binary=true']) {
      const res = await get(`/v2/ledgers/${NEXT}?${flags}`);
      expect([flags, res.status, res.body.ledger.transactions]).toEqual([flags, 200, []]);
    }
  });
});

describe('ledgers API endpoint on a ledger with a hole in its transactions', () => {
  let h: Harness;
  let get: ReturnType<typeof api>;
  beforeAll(async () => {
    h = await startHarness({ seed: 'ripple-mock' });
    get = api(h);
    // The ledger says it has 19 transactions; take one away.
    await h.ch.command(
      `DELETE FROM ${Table.Transactions} WHERE ledger_index = {index:UInt32} AND tx_index = {tx:UInt32}`,
      { index: 11119599, tx: 5 },
      { settings: { lightweight_deletes_sync: '2' } },
    );
  });
  afterAll(async () => {
    await h?.close();
  });

  it('is 500 unable to retrieve ledger when the transactions are asked for', async () => {
    for (const flags of ['expand=true', 'binary=true', 'transactions=true']) {
      const res = await get(`/v2/ledgers/11119599?${flags}`);
      expect([flags, res.status, res.body]).toEqual([
        flags,
        500,
        { result: 'error', message: 'unable to retrieve ledger' },
      ]);
    }
  });

  it('is served without the transactions: the header does not need them', async () => {
    const plain = await get('/v2/ledgers/11119599');
    expect(plain.status).toBe(200);
    expect(plain.body.ledger).toEqual(expectedLedger(11119599));
  });

  it('does not touch the other ledgers', async () => {
    expect((await get('/v2/ledgers/11119600?expand=true')).status).toBe(200);
  });
});

describe('ledgers API endpoint on the xahau-recorded ledgers', () => {
  const seed = 'xahau-recorded';
  let h: Harness;
  let get: ReturnType<typeof api>;
  const ledgers = [...fixtureSource(seed).list()].sort((a, b) => a.header.ledger_index - b.header.ledger_index);
  const newest = ledgers[ledgers.length - 1];
  beforeAll(async () => {
    h = await startHarness({ seed });
    get = api(h);
  });
  afterAll(async () => {
    await h?.close();
  });

  it('serves the latest ledger, by index, by hash and by date', async () => {
    const { header: hd } = newest;
    const latest = await get('/v2/ledgers');
    expect(latest.status).toBe(200);
    expect(latest.body.ledger).toMatchObject({
      ledger_hash: hd.ledger_hash,
      ledger_index: hd.ledger_index,
      parent_hash: hd.parent_hash,
      total_coins: hd.total_coins,
      close_time: hd.close_time,
      account_hash: hd.account_hash,
      transaction_hash: hd.transaction_hash,
      // the leftovers of the raw ledger, which the original also served
      hash: hd.ledger_hash,
      seqNum: String(hd.ledger_index),
      totalCoins: hd.total_coins,
      accepted: 'true',
      closed: 'true',
    });
    expect((await get(`/v2/ledgers/${hd.ledger_index}`)).body).toEqual(latest.body);
    expect((await get(`/v2/ledgers/${hd.ledger_hash.toLowerCase()}`)).body).toEqual(latest.body);
    const iso = new Date(hd.close_time * 1000).toISOString().slice(0, 19);
    expect((await get(`/v2/ledgers/${iso}`)).body.ledger.ledger_index).toBe(hd.ledger_index);
  });

  it('the transactions of every ledger, as hashes, objects and binary', async () => {
    for (const ledger of ledgers) {
      const index = ledger.header.ledger_index;
      const hashes = ledger.transactions.map((t) => t.hash);
      // transactions=true always lists them, an empty ledger gives []
      expect((await get(`/v2/ledgers/${index}?transactions=true`)).body.ledger.transactions).toEqual(hashes);
      // expand only applies to a ledger that has transactions; an empty one has no transactions key
      const expanded = (await get(`/v2/ledgers/${index}?expand=true`)).body.ledger;
      if (hashes.length > 0) {
        expect(expanded.transactions.map((t: { hash: string }) => t.hash)).toEqual(hashes);
      } else {
        expect(expanded).not.toHaveProperty('transactions');
      }
      const binary = await get(`/v2/ledgers/${index}?binary=true`);
      if (hashes.length > 0) {
        expect(transactionTreeRoot(binary.body.ledger.transactions)).toBe(ledger.header.transaction_hash);
      } else {
        expect(binary.body.ledger).not.toHaveProperty('transactions');
      }
    }
  });

  it('last_validated is the newest ledger', async () => {
    const res = await get('/v2/last_validated');
    expect(res.body.ledger_index).toBe(String(newest.header.ledger_index));
    expect(res.body.ledger_hash).toBe(newest.header.ledger_hash);
  });
});
