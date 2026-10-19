import { RippleHttpError } from '../common/errors';
import { encodeMarker } from '../common/pagination';
import { ValidatorDirectoryService } from './validator-directory.service';
import {
  VALIDATIONS_WINDOW_SECONDS,
  ValidatorValidationsService,
  validationsPageSql,
} from './validator-validations.service';

const MASTER = 'nHUkp7WhouVMobBUKGrV5FNqjsdD9zKP5jpGnnLLnYxUQSGAwrZ6';
const OTHER = 'nHBFpmLgxtyCSPCW4fWLgqwefcLBuQdkU7R6FNQVF2B5czacYLLA';
const SIGNING_A = 'n9MzwWa4dwdZkRzj6XmihBG4ymGtMPd12cLjfhKwx5Hoqeu6WEgy';
const SIGNING_B = 'n9KDJnaGhjHwsrJ2BzwUXDj7j9yVtQrVUdbRzB6Uc7TUczNV1HJp';
const SIGNING_OTHER = 'n9LpxYuMRL6mD5RA5KhzfhNB5RkQ6dRCNkm1ZQNqYEFWQRVz4yYa';

const hashOf = (ledger: number): string => ledger.toString(16).toUpperCase().padStart(64, '0');

/** A row of the page as the read gives it. */
const row = (ledger: number, over: Record<string, unknown> = {}) => ({
  ledger_index: ledger,
  ledger_hash: hashOf(ledger),
  sightings: '1',
  first_ms: '1760888571204',
  last_ms: '1760888571390',
  signing_key: SIGNING_A,
  signed_at: 814_567_890,
  is_full: 1,
  cut: 0,
  ...over,
});

type Row = ReturnType<typeof row>;

/**
 * A service over a ClickHouse that answers the page reads from `pages` in turn and the ledger lookup from `ledgers`, and a
 * directory whose manifests name `signing` (signing key -> master).
 */
function service(o: {
  pages?: Row[][];
  ledgers?: { ledger_index: number; ledger_hash: string }[];
  signing?: [string, string][];
}) {
  const pages = [...(o.pages ?? [[]])];
  const query = jest.fn(async (sql: string, _params?: Record<string, unknown>) => {
    if (sql.includes('{distinct_page_cap:UInt32}')) return pages.length > 1 ? pages.shift() : pages[0];
    return o.ledgers ?? [];
  });
  const directory = { get: jest.fn(async () => ({ signingToMaster: new Map(o.signing ?? []) })) };
  const svc = new ValidatorValidationsService({ query } as never, directory as unknown as ValidatorDirectoryService);
  const pageReads = (): { sql: string; params: Record<string, any> }[] =>
    query.mock.calls
      .filter(([sql]) => (sql as string).includes('{distinct_page_cap:UInt32}'))
      .map(([sql, params]) => ({ sql: sql as string, params: params as unknown as Record<string, any> }));
  return { svc, query, directory, pageReads };
}

describe('validationsPageSql', () => {
  it('reads one key with one capped read in the order of the key, and no UNION', () => {
    const sql = validationsPageSql(1, true, '');
    expect(sql.match(/LIMIT \{distinct_page_cap:UInt32\}/g)).toHaveLength(1);
    expect(sql).toContain('WHERE validation_public_key = {key0:String}');
    expect(sql).toContain('ORDER BY validation_public_key DESC, ledger_index DESC, ledger_hash DESC');
    expect(sql).toContain('ORDER BY ledger_index DESC, ledger_hash DESC\n LIMIT {distinct_page_limit:UInt32}');
    expect(sql).not.toContain('UNION');
    expect(sql).not.toContain('ASC');
  });

  it('reads each of three keys with a capped read of its own, combined with UNION ALL', () => {
    const sql = validationsPageSql(3, false, '');
    expect(sql.match(/LIMIT \{distinct_page_cap:UInt32\}/g)).toHaveLength(3);
    expect(sql.match(/UNION ALL/g)).toHaveLength(2);
    for (const i of [0, 1, 2]) expect(sql).toContain(`validation_public_key = {key${i}:String}`);
    expect(sql).not.toContain('{key3:String}');
    expect(sql.match(/ORDER BY validation_public_key ASC, ledger_index ASC, ledger_hash ASC/g)).toHaveLength(3);
    expect(sql).not.toContain('DESC');
    // never one read of all the keys ordered by ledger
    expect(sql).not.toMatch(/validation_public_key IN/);
  });

  it('puts the condition of the marker in every read, and the window of 7 days', () => {
    const sql = validationsPageSql(
      2,
      true,
      'ledger_index <= {k0:UInt32} AND (ledger_index, ledger_hash) < ({k0:UInt32}, {k1:String})',
    );
    expect(
      sql.match(
        /AND ledger_index <= \{k0:UInt32\} AND \(ledger_index, ledger_hash\) < \(\{k0:UInt32\}, \{k1:String\}\)/g,
      ),
    ).toHaveLength(2);
    expect(sql.match(/last_datetime >= toDateTime64\(\{since:UInt32\}, 3, 'UTC'\)/g)).toHaveLength(2);
  });

  it('marks the last group of a read that reached its cap: the least one when descending, the greatest when ascending', () => {
    expect(validationsPageSql(2, true, '')).toContain('= min((ledger_index, ledger_hash)) OVER (PARTITION BY source)');
    expect(validationsPageSql(2, false, '')).toContain('= max((ledger_index, ledger_hash)) OVER (PARTITION BY source)');
  });

  it('binds its values, has no FINAL, takes the table from the Table enum, and names no aggregate after its own column', () => {
    const sql = validationsPageSql(2, true, 'ledger_index <= {k0:UInt32}');
    expect(sql).not.toMatch(/\bFINAL\b/i);
    expect(sql).toMatch(/FROM validator_validations\b/);
    expect(sql).not.toMatch(/\bnH[1-9A-HJ-NP-Za-km-z]{20,}/);
    expect(sql).not.toMatch(/\bAS (count|full|signing_time|first_datetime|last_datetime|ephemeral_public_key)\b/);
  });
});

describe('ValidatorValidationsService.page', () => {
  it('reads the master key and the signing keys whose manifest names it, in the order master, then the others by key', async () => {
    const { svc, pageReads } = service({
      signing: [
        [SIGNING_B, MASTER],
        [SIGNING_OTHER, OTHER],
        [SIGNING_A, MASTER],
      ],
    });
    await svc.page(MASTER, { limit: 10, descending: true });
    const [read] = pageReads();
    expect(read.sql.match(/UNION ALL/g)).toHaveLength(2);
    expect([read.params.key0, read.params.key1, read.params.key2]).toEqual([MASTER, ...[SIGNING_A, SIGNING_B].sort()]);
    expect(read.params.key3).toBeUndefined();
    expect(Object.values(read.params)).not.toContain(OTHER);
    expect(Object.values(read.params)).not.toContain(SIGNING_OTHER);
  });

  it('reads one key for a master that no manifest names a signing key of', async () => {
    const { svc, pageReads } = service({ signing: [[SIGNING_OTHER, OTHER]] });
    await svc.page(MASTER, { limit: 10, descending: false });
    const [read] = pageReads();
    expect(read.sql).not.toContain('UNION');
    expect(read.params.key0).toBe(MASTER);
    expect(read.params.key1).toBeUndefined();
  });

  it('binds the page, the cap, the window of 7 days and the marker', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-19T15:43:00Z'));
    try {
      const { svc, pageReads } = service({});
      await svc.page(MASTER, { limit: 25, descending: true, marker: encodeMarker([107_748_180, hashOf(107_748_180)]) });
      const [read] = pageReads();
      expect(read.params).toEqual({
        k0: 107_748_180,
        k1: hashOf(107_748_180),
        key0: MASTER,
        since: Date.parse('2026-10-19T15:43:00Z') / 1000 - VALIDATIONS_WINDOW_SECONDS,
        distinct_page_limit: 26,
        // the page and room for as many duplicates
        distinct_page_cap: 50,
      });
      expect(VALIDATIONS_WINDOW_SECONDS).toBe(7 * 86_400);
    } finally {
      jest.useRealTimers();
    }
  });

  it('gives room for 16 duplicates at least', async () => {
    const { svc, pageReads } = service({});
    await svc.page(MASTER, { limit: 2, descending: true });
    expect(pageReads().map((read) => read.params.distinct_page_cap)).toEqual([18]);
  });

  it('answers 400 invalid marker for a marker that is none of ours, before any read', async () => {
    const { svc, query, directory } = service({});
    for (const marker of [
      '%%%',
      encodeMarker([1]),
      encodeMarker(['1', 'A']),
      encodeMarker([1, 2]),
      encodeMarker([-1, 'A']),
    ]) {
      let thrown: unknown;
      try {
        await svc.page(MASTER, { limit: 10, descending: true, marker });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(RippleHttpError);
      expect((thrown as RippleHttpError).getResponse()).toEqual({ result: 'error', message: 'invalid marker' });
    }
    expect(query).not.toHaveBeenCalled();
    expect(directory.get).not.toHaveBeenCalled();
  });

  it('serves the page and the marker of its last row when there is one row more; the row that tells there is more is cut', async () => {
    const { svc } = service({
      pages: [[row(30), row(29), row(28)]],
      ledgers: [{ ledger_index: 30, ledger_hash: hashOf(30) }],
    });
    const page = await svc.page(MASTER, { limit: 2, descending: true });
    expect(page.rows.map((each) => each.ledger_index)).toEqual([30, 29]);
    expect(page.marker).toBe(encodeMarker([29, hashOf(29)]));
  });

  it('has no marker when the page is not full of more', async () => {
    const { svc } = service({ pages: [[row(30), row(29)]] });
    const page = await svc.page(MASTER, { limit: 2, descending: true });
    expect(page.rows).toHaveLength(2);
    expect(page).not.toHaveProperty('marker');
  });

  it('says matches, different with the hash of the ledger, and unknown, from one lookup of the indices of the page', async () => {
    const { svc, query } = service({
      pages: [[row(30), row(29, { ledger_hash: 'AA'.repeat(32) }), row(29, { ledger_hash: 'BB'.repeat(32) }), row(28)]],
      ledgers: [
        { ledger_index: 30, ledger_hash: hashOf(30) },
        { ledger_index: 29, ledger_hash: 'AA'.repeat(32) },
      ],
    });
    const page = await svc.page(MASTER, { limit: 3, descending: true });
    expect(page.rows.map((each) => [each.ledger_index, each.validated, each.validated_hash])).toEqual([
      [30, 'matches', undefined],
      [29, 'matches', undefined],
      [29, 'different', 'AA'.repeat(32)],
    ]);
    const lookups = query.mock.calls.filter(([sql]) => (sql as string).includes('{indexes:Array(UInt32)}'));
    expect(lookups).toHaveLength(1);
    // the indices of the page, each once, and not the row that only tells there is more
    expect(lookups[0][1]).toEqual({ indexes: [30, 29] });
    expect(lookups[0][0]).toMatch(/FROM ledgers\b/);
  });

  it('looks nothing up for an empty page', async () => {
    const { svc, query } = service({ pages: [[]] });
    expect(await svc.page(MASTER, { limit: 3, descending: true })).toEqual({ rows: [] });
    expect(query).toHaveBeenCalledTimes(1);
  });

  describe('when a read stopped at its cap', () => {
    /** Ledgers 30 down to `to`, the last of them (the one the read ended in) cut. */
    const ending = (to: number): Row[] =>
      Array.from({ length: 30 - to + 1 }, (_, i) => row(30 - i, { cut: 30 - i === to ? 1 : 0 }));

    it('is read again with four times the room when the groups before the cut do not fill the page', async () => {
      // limit 10, room 16: 26 rows; the cut group is the 5th, so four are sure
      const { svc, pageReads } = service({ pages: [ending(26), Array.from({ length: 11 }, (_, i) => row(30 - i))] });
      const page = await svc.page(MASTER, { limit: 10, descending: true });
      expect(pageReads().map((read) => read.params.distinct_page_cap)).toEqual([26, 74]);
      expect(page.rows).toHaveLength(10);
      expect(page.marker).toBe(encodeMarker([21, hashOf(21)]));
    });

    it('keeps growing until the read is no longer capped, or the groups before the cut fill the page', async () => {
      const { svc, pageReads } = service({
        pages: [ending(29), ending(28), ending(27), Array.from({ length: 3 }, (_, i) => row(30 - i))],
      });
      const page = await svc.page(MASTER, { limit: 10, descending: true });
      expect(pageReads().map((read) => read.params.distinct_page_cap)).toEqual([26, 74, 266, 1034]);
      expect(page.rows).toHaveLength(3);
      expect(page).not.toHaveProperty('marker');
    });

    it('is not read again when the groups before the cut fill the page: the row that tells there is more may be the cut one', async () => {
      // 11 groups, the 11th is the cut one: ten are sure
      const { svc, pageReads } = service({ pages: [ending(20)] });
      const page = await svc.page(MASTER, { limit: 10, descending: true });
      expect(pageReads()).toHaveLength(1);
      expect(page.rows.map((each) => each.ledger_index)).toEqual(Array.from({ length: 10 }, (_, i) => 30 - i));
      expect(page.marker).toBe(encodeMarker([21, hashOf(21)]));
    });

    it('is not read again when no group of the page, or the one after it, is cut', async () => {
      const { svc, pageReads } = service({ pages: [Array.from({ length: 11 }, (_, i) => row(30 - i))] });
      await svc.page(MASTER, { limit: 10, descending: true });
      expect(pageReads()).toHaveLength(1);
    });

    it('stops at the largest cap there is', async () => {
      const { svc, pageReads } = service({ pages: [[row(30, { cut: 1 })]] });
      const page = await svc.page(MASTER, { limit: 1_500_000_000, descending: true });
      expect(pageReads().map((read) => read.params.distinct_page_cap)).toEqual([3_000_000_000, 4_294_967_295]);
      expect(page.rows).toHaveLength(1);
    });
  });
});
