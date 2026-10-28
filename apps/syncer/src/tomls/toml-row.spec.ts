import { DomainTomlsRow, EMPTY_TOML_CONTENT, okTomlRow, TomlContent } from '@gatehub/data-api-shared';
import { FetchFailure } from '../validators/safe-fetch';
import { nextTomlRow, TOML_BACKOFF_MAX_S, TOML_TRANSIENT_RECHECK_S, TomlCheck, TomlFailure } from './toml-row';

// Every domain, address and name below is hand-written test data.

/** 2025-10-24T10:00:00.500Z: a time with a fraction of a second, as the worker's clock gives. */
const NOW = 1_761_300_000.5;
const RECHECK_MS = 86_400_000;
const DAY = 86_400;
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
      'carries the content through a transient failure within 24 h of fetched_at (%s)',
      (_name, reason, statusCode) => {
        const prev = stored({}, DAY);
        const row = nextTomlRow(prev, failure(reason, statusCode), NOW, RECHECK_MS);
        expect(row).toEqual({
          domain: DOMAIN,
          toml_url: URL,
          status: 'failed',
          reason,
          status_code: reason === 'http_status' ? statusCode : 0,
          checked_at: NOW,
          // the time of the content in effect stays that of the file read, not of this check
          fetched_at: NOW - DAY,
          // 1_761_300_000.5 + 3_600 = 1_761_303_600.5, a whole second up
          next_check_at: 1_761_303_601,
          failures: prev.failures + 1,
          ...CONTENT,
        });
        expect(afterS(row)).toBe(TOML_TRANSIENT_RECHECK_S);
      },
    );

    it.each(TRANSIENT)('drops it a second later (%s)', (_name, reason, statusCode) => {
      const prev = stored({}, DAY + 1);
      const row = nextTomlRow(prev, failure(reason, statusCode), NOW, RECHECK_MS);
      expect(row).toEqual({
        domain: DOMAIN,
        toml_url: URL,
        status: 'failed',
        reason,
        status_code: reason === 'http_status' ? statusCode : 0,
        checked_at: NOW,
        fetched_at: null,
        next_check_at: 1_761_303_601,
        failures: prev.failures + 1,
        ...EMPTY_TOML_CONTENT,
      });
    });
  });

  describe('a transient failure after another', () => {
    it('keeps the fetched_at of the file, so the grace runs from the last read and not from the last failure', () => {
      // read 24 h and 300 s before NOW: still within the grace 600 s before NOW
      const first = nextTomlRow(stored({}, DAY + 300), failure('timeout'), NOW - 600, RECHECK_MS);
      expect(first).toMatchObject({ failures: 1, fetched_at: NOW - DAY - 300, ...CONTENT });
      // at NOW the file is 24 h and 300 s old: the content goes, though the row before still held it
      const second = nextTomlRow(first, failure('timeout'), NOW, RECHECK_MS);
      expect(second).toMatchObject({ failures: 2, fetched_at: null, ...EMPTY_TOML_CONTENT });
    });

    it('has nothing to carry when the row before holds no content', () => {
      const prev = stored({
        status: 'failed',
        reason: 'toml_invalid',
        failures: 1,
        fetched_at: null,
        ...EMPTY_TOML_CONTENT,
      });
      const row = nextTomlRow(prev, failure('dns_error'), NOW, RECHECK_MS);
      expect(row).toMatchObject({ failures: 2, fetched_at: null, ...EMPTY_TOML_CONTENT });
      expect(afterS(row)).toBe(TOML_TRANSIENT_RECHECK_S);
    });

    it('with no row before, is a failed row with no content and one failure', () => {
      const row = nextTomlRow(undefined, failure('connect_error'), NOW, RECHECK_MS);
      expect(row).toMatchObject({ status: 'failed', reason: 'connect_error', failures: 1, fetched_at: null });
      expect(row).toMatchObject(EMPTY_TOML_CONTENT);
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
