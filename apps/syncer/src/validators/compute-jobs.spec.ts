import { KEY_MAP_WITH, MANIFEST_MAP_SQL, mappedKey, Table } from '@gatehub/data-api-shared';
import { testKey } from '../../../../packages/shared/src/test-utils/validator-keys';
import { SyncerConfig } from '../config/syncer.config';
import { PrometheusService } from '../modules/prometheus/prometheus.service';
import { AgreementJob } from './agreement.job';
import { ComputeTick } from './compute-loop';
import { RoundsJob } from './rounds.job';

/**
 * The statements of the `rounds` and `agreement` jobs and the manifest map: each statement that groups rows by validator maps
 * its keys with the map it computes itself (`WITH key_map`), and no statement is sent the map as parameters (the client puts
 * parameters in the URL, which a map of every manifest stored outgrows). The jobs run on a ClickHouse that answers each read
 * with the few rows that make the job go through one round or a few hours; what they compute is the e2e suite's.
 */

const PUBLISHER = testKey('compute-jobs-publisher');
const PUBLISHERS = `https://unl.example=${PUBLISHER.publicKeyHex}`;
const HOUR = 3600;
const NOW_MS = Math.floor(Date.now() / 1000) * 1000;
const NOW = NOW_MS / 1000;
const MAPPED = mappedKey('validation_public_key');

interface Call {
  sql: string;
  params?: Record<string, unknown>;
}

/** A list of `unl.example` with three validators, as `readStoredLists` reads it. */
const LIST_ROW = {
  publisher: 'unl.example',
  publisher_key: PUBLISHER.publicKeyHex,
  sequence: 1,
  version: 1,
  effective: null,
  expiration: NOW + 30 * 86_400,
  validators: ['nHA', 'nHB', 'nHC'],
  fetched_ms: (NOW - 86_400) * 1000,
};

/** A ClickHouse that records every statement and answers it with `answer` (no rows when that has none). */
function recordingClickHouse(answer: (sql: string, params: Record<string, unknown>) => unknown[] | undefined) {
  const calls: Call[] = [];
  const query = jest.fn(async (sql: string, params?: Record<string, unknown>) => {
    calls.push({ sql, params });
    return answer(sql, params ?? {}) ?? [];
  });
  const ch = {
    query,
    queryOne: async (sql: string, params?: Record<string, unknown>) => (await query(sql, params))[0],
    insert: jest.fn(async (_table: string, _rows: unknown[]) => undefined),
  };
  return { ch, calls };
}

const config = () => Object.assign(new SyncerConfig(), { unlPublishers: PUBLISHERS });
const quiet = { log: () => undefined, warn: () => undefined, error: () => undefined };
const tick = (): ComputeTick => ({ now: NOW_MS, deadline: NOW_MS + 60_000, signal: new AbortController().signal });

/** The names of the parameters of a statement that would carry the manifest map. */
const mapParams = (call: Call): string[] =>
  Object.keys(call.params ?? {}).filter((name) => name === 'ephemerals' || name === 'masters');

function expectNoMapParameter(calls: Call[]): void {
  expect(calls.length).toBeGreaterThan(5);
  for (const call of calls) expect([call.sql, mapParams(call)]).toEqual([call.sql, []]);
  // nor is the map a read of its own
  expect(calls.filter((call) => call.sql === MANIFEST_MAP_SQL)).toEqual([]);
}

/** The statements that contain `marker`, each of which maps its keys with the map it computes. */
function expectMapped(calls: Call[], marker: string): void {
  const found = calls.filter((call) => call.sql.includes(marker));
  expect([marker, found.length > 0]).toEqual([marker, true]);
  for (const { sql } of found) {
    expect(sql).toContain(MAPPED);
    expect(sql.trimStart().startsWith(`WITH ${KEY_MAP_WITH}`)).toBe(true);
  }
}

describe('RoundsJob and the manifest map', () => {
  /** A database with a stored round 255 and the ledgers of round 511, whose validations come from two validators. */
  function roundsDatabase() {
    return recordingClickHouse((sql, params) => {
      if (sql.includes(`FROM ${Table.AmendmentTallies}`) && sql.includes('ORDER BY ledger_index DESC')) {
        return [{ ledger_index: 255 }];
      }
      if (sql.includes(`FROM ${Table.Ledgers}`) && sql.includes('ledger_index >= {round:UInt32}')) {
        return params.round === 511 ? [{ ledger_index: 511, ledger_hash: 'H511', closed: NOW - 1000 }] : [];
      }
      if (sql.includes(`FROM ${Table.Ledgers}`) && sql.includes('ORDER BY ledger_index DESC'))
        return [{ ledger_index: 600 }];
      if (sql.includes(`FROM ${Table.UnlLists}`)) return [LIST_ROW];
      if (sql.includes('toString(max(version)) AS newest') && sql.includes('UNION ALL')) return [{ newest: '0' }];
      if (sql.includes(`FROM ${Table.Validations}`)) {
        return ['nHA', 'nHB'].map((key) => ({
          vote_key: key,
          vote_full: 1,
          vote_amendments: '',
          vote_base_fee: null,
          vote_reserve_base: null,
          vote_reserve_inc: null,
          vote_server_version: null,
        }));
      }
      if (sql.includes(`FROM ${Table.AmendmentTallies}`) && sql.includes('ledger_index < {round:UInt32}')) {
        return [{ ledger_index: 255, newest_version: '1', unl_keys: ['nHA', 'nHB', 'nHC'], nunl_keys: [] }];
      }
      return undefined;
    });
  }

  it('maps the keys of the votes and of the history inside the statements, and sends the map to none', async () => {
    const { ch, calls } = roundsDatabase();
    const job = new RoundsJob(ch as never, config(), new PrometheusService(), { now: () => NOW_MS, logger: quiet });

    await job.run(tick());

    // the round was done: its votes and its tallies were written
    expect(ch.insert.mock.calls.map(([table]) => table)).toEqual([Table.ValidatorVotes, Table.AmendmentTallies]);
    expectNoMapParameter(calls);
    // the votes of the round (validations) and the votes of the rounds before it (validator_votes)
    expectMapped(calls, `FROM ${Table.Validations}`);
    expectMapped(calls, 'AS closed, amendments');
  });
});

describe('AgreementJob and the manifest map', () => {
  /** Three hours ago, on the hour: the first hour to compute, after a stored one. */
  const FIRST = Math.floor(NOW / HOUR) * HOUR - 3 * HOUR;

  function agreementDatabase() {
    return recordingClickHouse((sql) => {
      if (sql.includes('AS newest_closed')) return [{ newest_closed: NOW - 10 }];
      if (
        sql.includes(`FROM ${Table.ValidatorAgreementHourly}`) &&
        sql.includes('AS stored_hour') &&
        sql.includes('LIMIT 1')
      ) {
        return [{ stored_hour: FIRST - HOUR }];
      }
      if (sql.includes(`FROM ${Table.UnlLists}`)) return [LIST_ROW];
      if (sql.includes('AS ledger_hour')) {
        return [
          { ledger_index: 100, ledger_hour: FIRST },
          { ledger_index: 101, ledger_hour: FIRST },
        ];
      }
      if (sql.includes('ledger_index < {first:UInt32}')) return [{ ledger_index: 99 }];
      if (sql.includes('ledger_index > {last:UInt32}')) return [{ ledger_index: 102 }];
      return undefined;
    });
  }

  it('maps the keys of the validations and of the previous hour inside the statements, and sends the map to none', async () => {
    const { ch, calls } = agreementDatabase();
    const job = new AgreementJob(ch as never, config(), new PrometheusService(), { now: () => NOW_MS, logger: quiet });

    await job.run(tick());

    // the first hour was written
    const written = ch.insert.mock.calls as [string, { hour: number }[]][];
    expect(written[0][0]).toBe(Table.ValidatorAgreementHourly);
    expect(written[0][1][0].hour).toBe(FIRST);
    expectNoMapParameter(calls);
    // the validators heard in an hour, the validations of the ledgers of the window, and the tracked set of the hour before
    expectMapped(calls, 'AS seen_hour');
    expectMapped(calls, 'AS counted_hour');
    expectMapped(calls, 'AS tracked_key');
  });
});
