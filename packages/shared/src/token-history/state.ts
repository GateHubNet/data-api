import { ClickHouseService } from '../clickhouse/clickhouse.service';
import { TokenHistoryStateRow } from '../clickhouse/rows';
import { Table } from '../clickhouse/tables';

/**
 * The generations of the token history (spec 2.5, 4.6): `token_history_state` holds a row for every change of a generation, and
 * the newest version of a generation is its state. Readers name the live one.
 */

/** The newest row of each generation, without FINAL, in the order of the generations. */
const STATES_SQL = `SELECT generation, state, config_version, coverage_from, h0, h1, phase, account_cursor, token_cursor_issuer,
       token_cursor_currency, through_ledger, levels_through,
       toUnixTimestamp64Milli(started_at) AS started_ms, toUnixTimestamp64Milli(changed_at) AS changed_ms,
       toString(version) AS version_text
  FROM ${Table.TokenHistoryState}
 ORDER BY generation, version DESC
 LIMIT 1 BY generation`;

type Counted = number | string;

interface StateRead {
  generation: Counted;
  state: TokenHistoryStateRow['state'];
  config_version: Counted;
  coverage_from: Counted;
  h0: Counted;
  h1: Counted;
  phase: TokenHistoryStateRow['phase'];
  account_cursor: string;
  token_cursor_issuer: string;
  token_cursor_currency: string;
  through_ledger: Counted;
  levels_through: Counted;
  started_ms: Counted;
  changed_ms: Counted;
  version_text: string;
}

/** The state of every generation: its newest row, the lowest generation first. `version` is text, the times seconds with ms. */
export async function readTokenHistoryStates(ch: ClickHouseService): Promise<TokenHistoryStateRow[]> {
  const rows = await ch.query<StateRead>(STATES_SQL);
  return rows.map((r) => ({
    generation: Number(r.generation),
    state: r.state,
    config_version: Number(r.config_version),
    coverage_from: Number(r.coverage_from),
    h0: Number(r.h0),
    h1: Number(r.h1),
    phase: r.phase,
    account_cursor: r.account_cursor,
    token_cursor_issuer: r.token_cursor_issuer,
    token_cursor_currency: r.token_cursor_currency,
    through_ledger: Number(r.through_ledger),
    levels_through: Number(r.levels_through),
    started_at: Number(r.started_ms) / 1000,
    changed_at: Number(r.changed_ms) / 1000,
    version: r.version_text,
  }));
}

const highestIn = (rows: readonly TokenHistoryStateRow[], state: TokenHistoryStateRow['state']) =>
  rows.reduce<TokenHistoryStateRow | undefined>(
    (best, g) => (g.state === state && (best === undefined || g.generation > best.generation) ? g : best),
    undefined,
  );

/** The live generation: the highest whose state is `live`. Readers read only it. */
export function liveTokenHistory(rows: readonly TokenHistoryStateRow[]): TokenHistoryStateRow | undefined {
  return highestIn(rows, 'live');
}

/** The generation a build is making: the highest whose state is `building`. */
export function buildingTokenHistory(rows: readonly TokenHistoryStateRow[]): TokenHistoryStateRow | undefined {
  return highestIn(rows, 'building');
}

/** The number of a new generation: one above every generation written, 1 for the first. */
export function nextGeneration(rows: readonly TokenHistoryStateRow[]): number {
  return rows.reduce((max, r) => Math.max(max, r.generation), 0) + 1;
}

/**
 * Writes one row of a generation's state. Its `changed_at` is the server's clock, and its `version` the server's clock in
 * milliseconds, or one above the newest version stored when that is higher, so the row is the newest of its generation however the
 * clocks of two writers disagree.
 */
export async function writeTokenHistoryState(
  ch: ClickHouseService,
  row: Omit<TokenHistoryStateRow, 'version' | 'changed_at'>,
): Promise<void> {
  await ch.command(
    `INSERT INTO ${Table.TokenHistoryState}
       (generation, state, config_version, coverage_from, h0, h1, phase, account_cursor, token_cursor_issuer,
        token_cursor_currency, through_ledger, levels_through, started_at, changed_at, version)
     SELECT {generation:UInt32}, {state:String}, {config_version:UInt16}, {coverage_from:UInt32}, {h0:UInt32}, {h1:UInt32},
            {phase:String}, {account_cursor:String}, {token_cursor_issuer:String}, {token_cursor_currency:String},
            {through_ledger:UInt32}, {levels_through:UInt32}, fromUnixTimestamp64Milli({started_ms:Int64}, 'UTC'),
            now64(3, 'UTC'),
            greatest(toUInt64(toUnixTimestamp64Milli(now64(3))), (SELECT max(version) FROM ${Table.TokenHistoryState}) + 1)`,
    {
      generation: row.generation,
      state: row.state,
      config_version: row.config_version,
      coverage_from: row.coverage_from,
      h0: row.h0,
      h1: row.h1,
      phase: row.phase,
      account_cursor: row.account_cursor,
      token_cursor_issuer: row.token_cursor_issuer,
      token_cursor_currency: row.token_cursor_currency,
      through_ledger: row.through_ledger,
      levels_through: row.levels_through,
      started_ms: Math.round(row.started_at * 1000),
    },
  );
}

/** The fields of a generation's state a writer may change. */
export type TokenHistoryStatePatch = Partial<Omit<TokenHistoryStateRow, 'generation' | 'version' | 'changed_at' | 'started_at'>>;

/** The columns of `token_history_state` a patch can name, with their types. */
const PATCHABLE: ReadonlyArray<[keyof TokenHistoryStatePatch, string]> = [
  ['state', 'String'],
  ['config_version', 'UInt16'],
  ['coverage_from', 'UInt32'],
  ['h0', 'UInt32'],
  ['h1', 'UInt32'],
  ['phase', 'String'],
  ['account_cursor', 'String'],
  ['token_cursor_issuer', 'String'],
  ['token_cursor_currency', 'String'],
  ['through_ledger', 'UInt32'],
  ['levels_through', 'UInt32'],
];

/**
 * Writes a new state row of generation `g` that changes only the fields of `patch`: the other columns are copied from the newest
 * row by the same statement, on the server. The build and the worker each patch their own fields of a building generation (the
 * build its phase and cursors, the worker its `through_ledger`), so neither writes back a field it read before the other changed it,
 * except across one statement; a lost update only makes its writer redo an idempotent step. Throws when the generation has no row.
 */
export async function patchTokenHistoryState(
  ch: ClickHouseService,
  g: number,
  patch: TokenHistoryStatePatch,
): Promise<void> {
  const params: Record<string, unknown> = { g };
  const columns = PATCHABLE.map(([name, type]) => {
    if (patch[name] === undefined) return name;
    params[`p_${name}`] = patch[name];
    return `{p_${name}:${type}}`;
  });
  const exists = await ch.queryOne<{ n: string }>(
    `SELECT toString(count()) AS n FROM ${Table.TokenHistoryState} WHERE generation = {g:UInt32}`,
    { g },
  );
  if (exists === undefined || exists.n === '0') throw new Error(`token history generation ${g} has no state row`);
  await ch.command(
    `INSERT INTO ${Table.TokenHistoryState}
       (generation, ${PATCHABLE.map(([n]) => n).join(', ')}, started_at, changed_at, version)
     SELECT generation, ${columns.join(', ')}, started_at, now64(3, 'UTC'),
            greatest(toUInt64(toUnixTimestamp64Milli(now64(3))), (SELECT max(version) FROM ${Table.TokenHistoryState}) + 1)
       FROM (SELECT * FROM ${Table.TokenHistoryState} WHERE generation = {g:UInt32} ORDER BY version DESC LIMIT 1)`,
    params,
  );
}
