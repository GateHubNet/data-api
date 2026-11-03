import { DomainTomlsRow, EMPTY_TOML_CONTENT, okTomlRow, TomlContent } from '@gatehub/data-api-shared';
import { FetchFailure } from '../validators/safe-fetch';
import { nextTomlRow, TOML_BACKOFF_MAX_S, TOML_TRANSIENT_RECHECK_S, TomlCheck, TomlFailure } from './toml-row';

// Every domain, address and name below is hand-written test data.

/** 2025-10-24T10:00:00.500Z: a time with a fraction of a second, as the worker's clock gives. */
const NOW = 1_761_300_000.5;
const RECHECK_MS = 86_400_000;
const DAY = 86_400;
const HOUR = 3_600;
/** The default recheck of an ok row, in seconds: the content is carried this long and 24 h more. */
const RECHECK_S = RECHECK_MS / 1000;
const DOMAIN = 'northpeak.example';
const URL = `https://${DOMAIN}/.well-known/xrp-ledger.toml`;

const CONTENT: TomlContent = {
  modified: 1_760_000_000,
  expires: 1_790_000_000,
  accounts: [{ address: 'rNorthPeakAccount', network: 'main', desc: 'Treasury' }],
  currencies: [{ code: 'NPK', issuer: 'rNorthPeakIssuer', network: '', fields: '{"symbol":"NPK"}' }],
  validators: [{ public_key: 'nHBNorthPeakValidator', network: 'xahau', fields: '{}' }],
  principals: ['Ada North'],
};

/** The newest stored row of `DOMAIN`, an `ok` one fetched `ageS` seconds before `NOW` unless `over` says otherwise. */
function stored(over: Partial<DomainTomlsRow> = {}, ageS = 0): DomainTomlsRow {
  return {
    ...okTomlRow({ domain: DOMAIN, tomlUrl: URL, content: CONTENT, now: NOW - ageS, recheckMs: RECHECK_MS }),
    ...over,
  };
}

const failure = (reason: TomlFailure, statusCode?: number): TomlCheck => ({
  domain: DOMAIN,
  tomlUrl: URL,
  reason,
  ...(statusCode === undefined ? {} : { statusCode }),
});

/** The seconds the next check waits: `next_check_at` is a whole second, so it is counted from the whole second `NOW` is in. */
const afterS = (row: DomainTomlsRow): number => row.next_check_at - Math.ceil(NOW);

/** A case of the tables: its name, the reason, and the HTTP status of an `http_status`. */
type Case<R extends TomlFailure> = [name: string, reason: R, statusCode: number | undefined];

const TRANSIENT: Case<FetchFailure>[] = [
  ['dns_error', 'dns_error', undefined],
  ['connect_error', 'connect_error', undefined],
  ['tls_error', 'tls_error', undefined],
  ['timeout', 'timeout', undefined],
  ['http_status 503', 'http_status', 503],
  ['http_status 429', 'http_status', 429],
];

const DEFINITE: Case<TomlFailure>[] = [
  ['http_status 404', 'http_status', 404],
  ['toml_invalid', 'toml_invalid', undefined],
  ['too_large', 'too_large', undefined],
  ['redirect_rejected', 'redirect_rejected', undefined],
  ['blocked_address', 'blocked_address', undefined],
  ['domain_invalid', 'domain_invalid', undefined],
];

describe('nextTomlRow', () => {
  describe('a file that was read', () => {
    const check: TomlCheck = { domain: DOMAIN, tomlUrl: URL, content: CONTENT };

    it('is an ok row: the content, fetched now, no failures, the next check after the recheck time', () => {
      expect(nextTomlRow(undefined, check, NOW, RECHECK_MS)).toEqual({
        domain: DOMAIN,
        toml_url: URL,
        status: 'ok',
        reason: '',
        status_code: 0,
        checked_at: NOW,
        fetched_at: NOW,
        // 1_761_300_000.5 + 86_400 = 1_761_386_400.5, a whole second up
        next_check_at: 1_761_386_401,
        failures: 0,
        ...CONTENT,
      });
    });

    it('is exactly what okTomlRow gives, so the worker and recordToml write one row', () => {
      expect(nextTomlRow(undefined, check, NOW, RECHECK_MS)).toEqual(
        okTomlRow({ domain: DOMAIN, tomlUrl: URL, content: CONTENT, now: NOW, recheckMs: RECHECK_MS }),
      );
    });

    it('resets the failures and drops the reason of a failed row before it', () => {
      const prev = nextTomlRow(undefined, failure('http_status', 404), NOW - 7_200, RECHECK_MS);
      const prev4 = { ...prev, failures: 4 };
      const row = nextTomlRow(prev4, check, NOW, RECHECK_MS);
      expect(row).toMatchObject({ status: 'ok', reason: '', status_code: 0, failures: 0, fetched_at: NOW });
    });

    it('stores the domain in lower case', () => {
      const row = nextTomlRow(undefined, { ...check, domain: 'NorthPeak.Example' }, NOW, RECHECK_MS);
      expect(row.domain).toBe(DOMAIN);
    });
  });

  describe('a transient failure', () => {
    it.each(TRANSIENT)(
      'carries the content through a transient failure up to 24 h after the missed re-read of an ok row (%s)',
      (_name, reason, statusCode) => {
        // the ok row was due again RECHECK_S after its read; the grace runs 24 h from there
        const prev = stored({}, RECHECK_S + DAY);
        const row = nextTomlRow(prev, failure(reason, statusCode), NOW, RECHECK_MS);
        expect(row).toEqual({
          domain: DOMAIN,
          toml_url: URL,
          status: 'failed',
          reason,
          status_code: reason === 'http_status' ? statusCode : 0,
          checked_at: NOW,
          // the time of the content in effect stays that of the file read, not of this check
          fetched_at: NOW - RECHECK_S - DAY,
          // 1_761_300_000.5 + 3_600 = 1_761_303_600.5, a whole second up
          next_check_at: 1_761_303_601,
          failures: prev.failures + 1,
          ...CONTENT,
        });
        expect(afterS(row)).toBe(TOML_TRANSIENT_RECHECK_S);
      },
    );

    it.each(TRANSIENT)(
      'drops it a second later, and backs off a day: nothing is carried (%s)',
      (_name, reason, statusCode) => {
        const prev = stored({}, RECHECK_S + DAY + 1);
        const row = nextTomlRow(prev, failure(reason, statusCode), NOW, RECHECK_MS);
        expect(row).toEqual({
          domain: DOMAIN,
          toml_url: URL,
          status: 'failed',
          reason,
          status_code: reason === 'http_status' ? statusCode : 0,
          checked_at: NOW,
          fetched_at: null,
          // 1_761_300_000.5 + 86_400 = 1_761_386_400.5, a whole second up
          next_check_at: 1_761_386_401,
          failures: prev.failures + 1,
          ...EMPTY_TOML_CONTENT,
        });
        expect(afterS(row)).toBe(DAY);
      },
    );

    it('carries the content through a transient failure at the daily re-read', () => {
      // read at T0, re-read due at T0 + 24 h; the check runs 90 s after that and meets a 503
      const t0 = NOW - DAY - 90;
      const prev = stored({}, DAY + 90);
      expect(prev.next_check_at).toBe(Math.ceil(t0 + RECHECK_S));
      const row = nextTomlRow(prev, failure('http_status', 503), NOW, RECHECK_MS);
      expect(row).toMatchObject({
        status: 'failed',
        reason: 'http_status',
        status_code: 503,
        fetched_at: t0,
        ...CONTENT,
      });
      expect(afterS(row)).toBe(HOUR);
    });

    it('drops it 24 h after the missed re-read, whatever the recheck', () => {
      for (const recheckMs of [RECHECK_MS, 6 * HOUR * 1000, 3 * DAY * 1000]) {
        const graceEnd = recheckMs / 1000 + DAY;
        const at = (ageS: number) => nextTomlRow(stored({}, ageS), failure('timeout'), NOW, recheckMs);
        expect([recheckMs, at(graceEnd).fetched_at]).toEqual([recheckMs, NOW - graceEnd]);
        expect([recheckMs, at(graceEnd + 1).fetched_at]).toEqual([recheckMs, null]);
        expect(at(graceEnd + 1).accounts).toEqual([]);
      }
    });
  });

  describe('a transient failure after another', () => {
    it('keeps the fetched_at of the file, so the grace runs from the last read and not from the last failure', () => {
      // read 48 h and 300 s before NOW: still within the grace 600 s before NOW
      const first = nextTomlRow(stored({}, RECHECK_S + DAY + 300), failure('timeout'), NOW - 600, RECHECK_MS);
      expect(first).toMatchObject({ failures: 1, fetched_at: NOW - RECHECK_S - DAY - 300, ...CONTENT });
      // at NOW the file is 48 h and 300 s old: the content goes, though the row before still held it
      const second = nextTomlRow(first, failure('timeout'), NOW, RECHECK_MS);
      expect(second).toMatchObject({ failures: 2, fetched_at: null, ...EMPTY_TOML_CONTENT });
    });

    it('has nothing to carry when the row before holds no content, and goes on with its backoff: 2 days after a day', () => {
      // a definite failure a day ago, checked again a day after it
      const prev = nextTomlRow(stored({}, 3 * DAY), failure('toml_invalid'), NOW - DAY, RECHECK_MS);
      expect(prev).toMatchObject({ failures: 1, fetched_at: null, next_check_at: Math.ceil(NOW) });
      const row = nextTomlRow(prev, failure('dns_error'), NOW, RECHECK_MS);
      expect(row).toMatchObject({ failures: 2, fetched_at: null, ...EMPTY_TOML_CONTENT });
      expect(afterS(row)).toBe(2 * DAY);
    });

    it('with no row before, is a failed row with no content and one failure, checked again after a day', () => {
      const row = nextTomlRow(undefined, failure('connect_error'), NOW, RECHECK_MS);
      expect(row).toMatchObject({ status: 'failed', reason: 'connect_error', failures: 1, fetched_at: null });
      expect(row).toMatchObject(EMPTY_TOML_CONTENT);
      expect(afterS(row)).toBe(DAY);
    });

    it('backs a transient failure off once its content is no longer carried: hourly, then 1, 2, 4, then 7 days', () => {
      // an ok row read at NOW, then a host that times out at every check from its daily re-read on
      let row = stored();
      const waits: number[] = [];
      const carried: boolean[] = [];
      for (let check = 0; check < 29; check++) {
        const at = row.next_check_at;
        row = nextTomlRow(row, failure('timeout'), at, RECHECK_MS);
        waits.push(row.next_check_at - at);
        carried.push(row.fetched_at !== null);
      }
      // carried up to 48 h after the read: the re-read at +24 h and 23 hourly checks after it
      expect(carried).toEqual([...Array(24).fill(true), ...Array(5).fill(false)]);
      expect(waits).toEqual([...Array(24).fill(HOUR), DAY, 2 * DAY, 4 * DAY, TOML_BACKOFF_MAX_S, TOML_BACKOFF_MAX_S]);
      expect(row.failures).toBe(29);
    });

    it('starts the backoff at a day after a row with no content that waited less', () => {
      const prev = stored({
        status: 'failed',
        reason: 'timeout',
        failures: 3,
        fetched_at: null,
        next_check_at: Math.ceil(NOW - HOUR),
        checked_at: NOW - 2 * HOUR,
        ...EMPTY_TOML_CONTENT,
      });
      expect(afterS(nextTomlRow(prev, failure('timeout'), NOW, RECHECK_MS))).toBe(DAY);
    });

    it('does not share the lists of the row before', () => {
      const prev = stored({}, 60);
      const row = nextTomlRow(prev, failure('timeout'), NOW, RECHECK_MS);
      expect(row.accounts).toEqual(prev.accounts);
      expect(row.accounts).not.toBe(prev.accounts);
      expect(row.principals).not.toBe(prev.principals);
    });
  });

  describe('a definite failure', () => {
    it.each(DEFINITE)(
      'stores no content, even when the file was read a minute ago (%s)',
      (_name, reason, statusCode) => {
        const prev = stored({}, 60);
        const row = nextTomlRow(prev, failure(reason, statusCode), NOW, RECHECK_MS);
        expect(row).toEqual({
          domain: DOMAIN,
          toml_url: URL,
          status: 'failed',
          reason,
          // the code of an http_status only
          status_code: statusCode === 404 ? 404 : 0,
          checked_at: NOW,
          fetched_at: null,
          // one failure: a day
          next_check_at: 1_761_386_401,
          failures: 1,
          ...EMPTY_TOML_CONTENT,
        });
      },
    );
  });

  describe('the backoff of a definite failure', () => {
    it('backs off 1, 2, 4, then 7 days', () => {
      const days: number[] = [];
      for (let failures = 1; failures <= 5; failures++) {
        const prev =
          failures === 1 ? undefined : stored({ status: 'failed', reason: 'too_large', failures: failures - 1 });
        const row = nextTomlRow(prev, failure('too_large'), NOW, RECHECK_MS);
        expect(row.failures).toBe(failures);
        days.push(afterS(row));
      }
      expect(days).toEqual([86_400, 172_800, 345_600, 604_800, 604_800]);
      expect(TOML_BACKOFF_MAX_S).toBe(604_800);
    });

    it('stays at 7 days for any count of failures', () => {
      const prev = stored({ status: 'failed', reason: 'too_large', failures: 65_000 });
      const row = nextTomlRow(prev, failure('http_status', 404), NOW, RECHECK_MS);
      expect(afterS(row)).toBe(TOML_BACKOFF_MAX_S);
    });

    it('stops counting at 65,535, the most the failures column holds, instead of wrapping to 0 (which would read as ok)', () => {
      const atTheTop = stored({ status: 'failed', reason: 'too_large', failures: 65_534 });
      expect(nextTomlRow(atTheTop, failure('too_large'), NOW, RECHECK_MS).failures).toBe(65_535);

      const full = stored({ status: 'failed', reason: 'timeout', failures: 65_535 });
      for (const check of [failure('timeout'), failure('http_status', 404), failure('toml_invalid')]) {
        const row = nextTomlRow(full, check, NOW, RECHECK_MS);
        expect(row.failures).toBe(65_535);
        expect(row.status).toBe('failed');
      }
    });

    it('counts the transient failures before it', () => {
      const prev = stored({ status: 'failed', reason: 'timeout', failures: 2 });
      const row = nextTomlRow(prev, failure('toml_invalid'), NOW, RECHECK_MS);
      // the third failure in a row: 4 days
      expect(row.failures).toBe(3);
      expect(afterS(row)).toBe(345_600);
    });

    it('does not depend on the recheck time of the ok rows', () => {
      const row = nextTomlRow(undefined, failure('domain_invalid'), NOW, 1_000);
      expect(afterS(row)).toBe(DAY);
    });
  });

  it('stores the domain of a failed row in lower case', () => {
    for (const reason of ['timeout', 'too_large'] as const) {
      const row = nextTomlRow(undefined, { ...failure(reason), domain: 'NorthPeak.Example' }, NOW, RECHECK_MS);
      expect(row.domain).toBe(DOMAIN);
    }
  });

  it('gives a whole second to next_check_at', () => {
    for (const check of [
      failure('timeout'),
      failure('too_large'),
      { domain: DOMAIN, tomlUrl: URL, content: CONTENT },
    ]) {
      expect(Number.isInteger(nextTomlRow(undefined, check, NOW, RECHECK_MS).next_check_at)).toBe(true);
    }
  });
});
