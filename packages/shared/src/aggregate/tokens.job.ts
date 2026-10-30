import { ClickHouseService } from '../clickhouse/clickhouse.service';
import { STATE_PARSER_VERSION, TokenGenerationsRow, TokensRow } from '../clickhouse/rows';
import { Table } from '../clickhouse/tables';
import { NetworkProfile } from '../network/network-profile';
import { exactAmount, exactSum, floatSum, sumOf } from '../query/decimal';
import { coverageFrom } from '../query/parser-coverage';
import { accountDomainOf } from '../tomls/account-domain';
import { TomlCurrency } from '../tomls/toml-read';
import { readStoredTomls } from '../tomls/toml-store';
import { currencyCode, LP_CURRENCY } from '../util/currency-code';
import { chunk } from '../util/helpers';
import { TokenKey, tokenListing, TokenListing } from './token-rules';

/**
 * The `tokens` job's shared functions (spec sections 2.2 to 2.4, 3.1 and 3.7): the generations of the token set, the account pass that
 * builds a generation's `token_lines` from `trust_line_states`, and the `tokens` rows made of them. The runner that calls them is the
 * syncer's `TokensJobRunner`; the constants below are the job's, the ones of the touch windows and of the housekeeping included.
 *
 *  - **A generation is one build** of the token set: `token_generations` holds its state, one row for every change, and the newest
 *    row of a generation is its state (`readTokenGenerations`). `token_lines` and `tokens` are partitioned by generation, and every
 *    read of them names one.
 *  - **Every write is idempotent and versioned.** A row is a function of the ledger state it is computed from; a version is the
 *    runner's clock in milliseconds, at least one more than any version already written (`tokensVersionFloor` gives the floor), and
 *    is passed in: the functions here never read a clock. Readers keep the newest version of a key (`LIMIT 1 BY`, no `FINAL`) and
 *    drop `deleted = 1` after that.
 *  - **The pass reads a key range.** `trust_line_states` is ordered by `account`; a batch of `TOKENS_PASS_ACCOUNTS` accounts is the
 *    range `(after, through]` of it. `nextPassAccounts` finds the batch's last account by reading the table in key order and
 *    stopping after the batch (a granule or so of each part: not every row after the cursor), and `writePassLines` reads the newest
 *    row of each line of those accounts at or before the head, from the account's side as the issuer (`issuer = account`), in one
 *    `INSERT ... SELECT`. Each line is written once, by its issuer's side, so both orientations of a line come from its two accounts.
 *  - **Query parameters travel in the URL** and ClickHouse refuses one over 128 KiB (ADR-0012): every array parameter holds at most
 *    `TOKENS_STATE_CHUNK` keys of at most 40 characters, or `TOKENS_TOML_DOMAINS_CHUNK` domains of at most 128, so every read that
 *    names accounts, tokens or domains goes by chunks.
 *  - **Nothing is written once the shutdown has begun**: `signal` is checked before each read of a chunk and each write.
 */

/** A change of the token rules (the listing, the supply) that needs every token computed again bumps this: the runner starts a new generation. */
export const TOKENS_CONFIG_VERSION = 1;

/** How many accounts one batch of the account pass covers. */
export const TOKENS_PASS_ACCOUNTS = 500;

/** How many ledgers one window of touches covers, halved while a window holds more than `TOKENS_TOUCH_WINDOW_MAX_LINES` distinct lines. */
export const TOKENS_TOUCH_WINDOW = 500;
export const TOKENS_TOUCH_WINDOW_MAX_LINES = 20_000;

/** How many keys (lines, tokens or issuers; at most 40 characters each) one read names: under 90 KB for one array parameter. */
export const TOKENS_STATE_CHUNK = 2_000;

/** How many domains one read of the toml store names: up to 128 characters each, 500 of them are about 70 KB. */
export const TOKENS_TOML_DOMAINS_CHUNK = 500;

/** How many runs of the job make a housekeeping run (rebuild check, distinct holders, toml sweep). */
export const TOKENS_HOUSEKEEPING_EVERY_TICKS = 10;

/** How long a retired generation is kept, in milliseconds, before its partitions are dropped. */
export const TOKENS_RETIRED_KEEP_MS = 15 * 60_000;

/** With no live generation, a building one is promoted once it is within this many ledgers of the head. */
export const TOKENS_PROMOTE_NEAR_HEAD = 10;

type Counted = number | string;

/** Thrown by a function whose `signal` was aborted: nothing was written after the abort. */
export class TokensAborted extends Error {
  constructor() {
    super('The tokens job was aborted before it wrote');
    this.name = 'TokensAborted';
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new TokensAborted();
}

/** The key a token has in this file's maps: unambiguous whatever characters a currency holds. */
const keyOf = (token: TokenKey): string => JSON.stringify([token.issuer, token.currency]);

// ---------------------------------------------------------------------------------------------------------------------
// Generations
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The newest row of each generation (`ORDER BY generation, version DESC LIMIT 1 BY generation`), in the order of the generations.
 * `version` comes back as text (a `UInt64` passes 2^53), the times as `DateTime64(3)` milliseconds.
 */
const GENERATIONS_SQL = `SELECT generation, state, config_version, coverage_from, head_ledger, account_cursor, pass_done,
       through_ledger, repair_from, holders, holders_ledger,
       toUnixTimestamp64Milli(started_at) AS started_ms, toUnixTimestamp64Milli(changed_at) AS changed_ms,
       toString(version) AS version_text
  FROM ${Table.TokenGenerations}
 ORDER BY generation, version DESC
 LIMIT 1 BY generation`;

/** A row of `GENERATIONS_SQL` as ClickHouse gives it: an `Int64` quoted. */
interface GenerationRead {
  generation: Counted;
  state: TokenGenerationsRow['state'];
  config_version: Counted;
  coverage_from: Counted;
  head_ledger: Counted;
  account_cursor: string;
  pass_done: Counted;
  through_ledger: Counted;
  repair_from: Counted;
  holders: Counted;
  holders_ledger: Counted;
  started_ms: Counted;
  changed_ms: Counted;
  version_text: string;
}

/** The state of every generation: its newest row, in the order of the generations (the lowest first). */
export async function readTokenGenerations(ch: ClickHouseService): Promise<TokenGenerationsRow[]> {
  const rows = await ch.query<GenerationRead>(GENERATIONS_SQL);
  return rows.map((row) => ({
    generation: Number(row.generation),
    state: row.state,
    config_version: Number(row.config_version),
    coverage_from: Number(row.coverage_from),
    head_ledger: Number(row.head_ledger),
    account_cursor: row.account_cursor,
    pass_done: Number(row.pass_done),
    through_ledger: Number(row.through_ledger),
    repair_from: Number(row.repair_from),
    holders: Number(row.holders),
    holders_ledger: Number(row.holders_ledger),
    started_at: Number(row.started_ms) / 1000,
    changed_at: Number(row.changed_ms) / 1000,
    version: row.version_text,
  }));
}

const highestIn = (gens: readonly TokenGenerationsRow[], state: TokenGenerationsRow['state']) =>
  gens.reduce<TokenGenerationsRow | undefined>(
    (best, g) => (g.state === state && (best === undefined || g.generation > best.generation) ? g : best),
    undefined,
  );

/** The live generation: the highest whose state is `live` (spec 2.2). */
export function liveGenerationOf(gens: readonly TokenGenerationsRow[]): TokenGenerationsRow | undefined {
  return highestIn(gens, 'live');
}

/** The generation that builds: the highest whose state is `building`. */
export function buildingGenerationOf(gens: readonly TokenGenerationsRow[]): TokenGenerationsRow | undefined {
  return highestIn(gens, 'building');
}

/** Writes one row of a generation's state (the caller gives it a version above any written). */
export async function writeTokenGeneration(
  ch: ClickHouseService,
  row: TokenGenerationsRow,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  await ch.insert(Table.TokenGenerations, [row]);
}

/**
 * Where the state tables are readable from (spec 6): one more than the newest ledger an older parser wrote
 * (`newestLedgerBelowVersion(ch, STATE_PARSER_VERSION)`), else the oldest stored ledger, `undefined` when no ledger is stored.
 */
export async function stateCoverageStart(ch: ClickHouseService): Promise<number | undefined> {
  return (await coverageFrom(ch, STATE_PARSER_VERSION)) ?? undefined;
}

const NEWEST_GENERATION_VERSION_SQL = `SELECT toString(max(version)) AS newest FROM ${Table.TokenGenerations}`;

/** The newest version of the rows of some generations of a table (partition pruned: they name `generation`). */
const newestVersionSql = (table: Table): string =>
  `SELECT toString(max(version)) AS newest FROM ${table} WHERE generation IN {generations:Array(UInt32)}`;

/**
 * The highest version written to `token_generations`, or to the `tokens` and `token_lines` rows of the generations that are not
 * retired (a retired one is dropped and never read again), as text; `'0'` when none. A version is at least one more than the newest of
 * its key (spec 2.3), so the runner starts its clock above this floor. The two aggregates are read by the partitions of the live and
 * the building generations, one `max` of one column each.
 */
export async function tokensVersionFloor(ch: ClickHouseService): Promise<string> {
  const generations = (await readTokenGenerations(ch)).filter((g) => g.state !== 'retired').map((g) => g.generation);
  const reads = [ch.queryOne<{ newest: string }>(NEWEST_GENERATION_VERSION_SQL)];
  if (generations.length > 0) {
    for (const table of [Table.Tokens, Table.TokenLines]) {
      reads.push(ch.queryOne<{ newest: string }>(newestVersionSql(table), { generations }));
    }
  }
  let floor = 0n;
  for (const row of await Promise.all(reads)) {
    const newest = BigInt(row?.newest ?? '0');
    if (newest > floor) floor = newest;
  }
  return floor.toString();
}

// ---------------------------------------------------------------------------------------------------------------------
// The account pass
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The next accounts of the pass in key order. `GROUP BY account ORDER BY account LIMIT n` with `optimize_aggregation_in_order` reads
 * the table in the order of its key and stops after `n` groups, a granule or a few of each part; `max_block_size` at the table's
 * granule (8,192 rows) keeps the blocks of that read as small. `LIMIT 1 BY account LIMIT n` gives the same accounts but is not stopped
 * by the limit: it reads every row after the cursor (measured on ClickHouse 26.8, spec 3.1 step 1).
 */
const NEXT_ACCOUNTS_SQL = `SELECT account
  FROM ${Table.TrustLineStates}
 WHERE account > {after:String}
 GROUP BY account
 ORDER BY account
 LIMIT {n:UInt32}`;

const NEXT_ACCOUNTS_SETTINGS = { optimize_aggregation_in_order: 1, max_block_size: '8192' } as const;

/**
 * The accounts that have a trust line after `after`, in key order, at most `n` (spec 3.1 step 1): the accounts of the next batch of
 * the pass. Empty once the pass has passed the last account. `after` is `''` for the first batch. The read is bounded by the batch,
 * not by the rows after the cursor: about one granule of each part of the table, plus the rows of an account that fills a part.
 */
export async function nextPassAccounts(ch: ClickHouseService, after: string, n: number): Promise<string[]> {
  const rows = await ch.query<{ account: string }>(NEXT_ACCOUNTS_SQL, { after, n }, NEXT_ACCOUNTS_SETTINGS);
  return rows.map((row) => row.account);
}

/**
 * The lines of the issuers `(after, through]`, as the `token_lines` rows of generation `g`, from the issuer's side (spec 3.1 step 2).
 * The inner select is the newest row of each line of those accounts at or before the head: a key range of `trust_line_states`
 * (`account`) and the newest state of each (account, counterparty, currency). A row is the account as the issuer when its balance is
 * below 0 (the counterparty holds the token, and its balance is the negation) or is 0 with a limit of the counterparty's above 0
 * (`limit_peer`), the counting rule of spec 1 from the issuer's side. A deleted line and an LP token's currency count for nothing.
 * `limit_peer` is the holder's limit, `freeze` and `authorized` the issuer's flags. The balance of `holder_balance` is `'0'` for a
 * zero balance, never `'-0'`: the parser writes a zero as `'0'`.
 */
export const PASS_LINES_SELECT = `SELECT {g:UInt32}, account, currency, counterparty,
       if(startsWith(balance, '-'), substring(balance, 2), '0') AS holder_balance, toFloat64(holder_balance),
       limit_peer, freeze, authorized, ledger_index, 0, {version:UInt64}
  FROM (SELECT account, counterparty, currency, ledger_index, balance, limit_peer, freeze, authorized, deleted
          FROM ${Table.TrustLineStates}
         WHERE account > {after:String} AND account <= {through:String} AND ledger_index <= {head:UInt32}
         ORDER BY account, counterparty, currency, ledger_index DESC, tx_index DESC, node_index DESC
         LIMIT 1 BY account, counterparty, currency)
 WHERE deleted = 0 AND NOT match(currency, '${LP_CURRENCY.source}')
   AND (startsWith(balance, '-') OR (balance = '0' AND limit_peer != '0'))`;

const PASS_LINES_SQL = `INSERT INTO ${Table.TokenLines}
       (generation, issuer, currency, holder, balance, balance_f, \`limit\`, frozen, authorized, ledger_index, deleted, version)
${PASS_LINES_SELECT}`;

/**
 * Writes the `token_lines` rows of the issuers `(after, through]` into generation `p.generation`, from the lines as they stood at
 * `p.head`, all under `p.version` (spec 3.1 step 2). Server-side: nothing travels through the job. An issuer with millions of rows is
 * one statement; it is not split. Writing a batch again leaves the same rows under a newer version.
 */
export async function writePassLines(
  ch: ClickHouseService,
  p: { generation: number; after: string; through: string; head: number; version: string },
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  await ch.command(PASS_LINES_SQL, {
    g: p.generation,
    after: p.after,
    through: p.through,
    head: p.head,
    version: p.version,
  });
}

/** The tokens of the issuers `(after, through]` in a generation: a key range of `token_lines`, whose key starts with the issuer. */
const PASS_TOKENS_SQL = `SELECT DISTINCT issuer, currency
  FROM ${Table.TokenLines}
 WHERE generation = {g:UInt32} AND issuer > {after:String} AND issuer <= {through:String}
 ORDER BY issuer, currency`;

/**
 * The tokens that have a line in generation `p.generation` among the issuers `(after, through]`: the tokens the pass just wrote
 * rows for (the batch's tokens whose rows `recomputeTokens` makes), in key order.
 */
export async function passTokens(
  ch: ClickHouseService,
  p: { generation: number; after: string; through: string },
): Promise<TokenKey[]> {
  return ch.query<TokenKey>(PASS_TOKENS_SQL, { g: p.generation, after: p.after, through: p.through });
}

// ---------------------------------------------------------------------------------------------------------------------
// Domains and tomls of the issuers
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The newest row of each account asked, by key (`account` is the sort key of the table): the domain it holds and whether the node
 * was deleted, by `argMax` of `version`, never `FINAL`. The aliases are not column names.
 */
const ISSUER_DOMAINS_SQL = `SELECT account, argMax(domain_hex, version) AS top_hex, argMax(deleted, version) AS gone
  FROM ${Table.AccountDomains}
 WHERE account IN {issuers:Array(String)}
 GROUP BY account`;

/**
 * The account domain of each issuer (D4's `accountDomainOf` of its current `account_domains` row, spec 3.7), `''` when it has none:
 * no row, a deleted one, an empty Domain, or one that is no domain. Every issuer asked is in the map. Read by chunks of
 * `TOKENS_STATE_CHUNK` accounts.
 */
export async function issuerDomains(ch: ClickHouseService, issuers: readonly string[]): Promise<Map<string, string>> {
  const domains = new Map<string, string>();
  const distinct = [...new Set(issuers)];
  for (const issuer of distinct) domains.set(issuer, '');
  for (const part of chunk(distinct, TOKENS_STATE_CHUNK)) {
    const rows = await ch.query<{ account: string; top_hex: string; gone: Counted }>(ISSUER_DOMAINS_SQL, {
      issuers: part,
    });
    for (const row of rows) {
      if (Number(row.gone) === 0 && row.top_hex !== '') domains.set(row.account, accountDomainOf(row.top_hex) ?? '');
    }
  }
  return domains;
}

/** The `[[CURRENCIES]]` entries of each of some domains that have a stored toml, read by chunks of `TOKENS_TOML_DOMAINS_CHUNK`. */
async function currenciesOf(ch: ClickHouseService, domains: readonly string[]): Promise<Map<string, TomlCurrency[]>> {
  const currencies = new Map<string, TomlCurrency[]>();
  for (const part of chunk([...new Set(domains)], TOKENS_TOML_DOMAINS_CHUNK)) {
    for (const [domain, row] of await readStoredTomls(ch, part)) currencies.set(domain, row.currencies);
  }
  return currencies;
}

// ---------------------------------------------------------------------------------------------------------------------
// The token rows
// ---------------------------------------------------------------------------------------------------------------------

/** The tokens named by two arrays zipped (as `paymentsByKeys` does), so that the keys are one parameter each. */
const TOKEN_KEYS_IN = `(issuer, currency) IN (
            SELECT tupleElement(key, 1), tupleElement(key, 2)
              FROM (SELECT arrayJoin(arrayZip({issuers:Array(String)}, {currencies:Array(String)})) AS key))`;

/**
 * The totals of some tokens in a generation: over the newest row of each (issuer, currency, holder) inside, `deleted = 0` outside.
 * `n_holders` the lines with a balance above 0, `n_lines` all of them, the exact sum of the balances with the count of those the
 * decimal cannot hold whole (`n_unfit`, `sumOf` falls back to the Float64 sum) and the newest ledger. The aliases are not column names.
 */
const TOKEN_TOTALS_SQL = `SELECT issuer, currency,
       toUInt32(countIf(balance_f > 0)) AS n_holders,
       toUInt32(count()) AS n_lines,
       ${exactSum('balance_exact')} AS supply_exact,
       toUInt32(countIf(balance_exact IS NULL)) AS n_unfit,
       ${floatSum('balance_f')} AS supply_float,
       max(ledger_index) AS newest_ledger
  FROM (SELECT issuer, currency, ${exactAmount('balance')} AS balance_exact, balance_f, ledger_index
          FROM (SELECT issuer, currency, balance, balance_f, ledger_index, deleted
                  FROM ${Table.TokenLines}
                 WHERE generation = {g:UInt32} AND ${TOKEN_KEYS_IN}
                 ORDER BY issuer, currency, holder, version DESC
                 LIMIT 1 BY issuer, currency, holder)
         WHERE deleted = 0)
 GROUP BY issuer, currency`;

interface TotalsRead {
  issuer: string;
  currency: string;
  n_holders: Counted;
  n_lines: Counted;
  supply_exact: string | null;
  n_unfit: Counted;
  supply_float: number | null;
  newest_ledger: Counted;
}

/** The newest `tokens` row of each of some tokens in a generation: what a row keeps when the token's listing is not matched again. */
const NEWEST_TOKENS_SQL = `SELECT issuer, currency, domain, listed, name, toml, deleted
  FROM ${Table.Tokens}
 WHERE generation = {g:UInt32} AND ${TOKEN_KEYS_IN}
 ORDER BY issuer, currency, version DESC
 LIMIT 1 BY issuer, currency`;

interface StoredTokenRead extends TokenKey {
  domain: string;
  listed: Counted;
  name: string;
  toml: string;
  deleted: Counted;
}

/**
 * The newest `account_states` row of each issuer at or before a ledger, by the prefix `account` of the key: its flags and its
 * `TransferRate` (`0` when absent). `rate` is not a column name.
 */
const ISSUER_SETTINGS_SQL = `SELECT account, flags, toUInt32(JSONExtractUInt(fields, 'TransferRate')) AS rate, ledger_index, deleted
  FROM ${Table.AccountStates}
 WHERE account IN {issuers:Array(String)} AND ledger_index <= {at:UInt32}
 ORDER BY account, ledger_index DESC, tx_index DESC, node_index DESC
 LIMIT 1 BY account`;

interface SettingsRead {
  account: string;
  flags: Counted;
  rate: Counted;
  ledger_index: Counted;
  deleted: Counted;
}

/** What `tokens` says of an issuer's settings (spec 2.4): all 0 when the issuer has no row in the state tables, or its row is a deletion. */
interface IssuerSettings {
  issuer_ledger: number;
  issuer_flags: number;
  transfer_rate: number;
}

const NO_SETTINGS: IssuerSettings = { issuer_ledger: 0, issuer_flags: 0, transfer_rate: 0 };

/** A token with no line that counts: the row that takes it out of the readers' sight. */
function deletedRow(generation: number, token: TokenKey, version: string): TokensRow {
  return {
    generation,
    issuer: token.issuer,
    currency: token.currency,
    code: currencyCode(token.currency) ?? '',
    holders: 0,
    trust_lines: 0,
    supply: '0',
    supply_f: 0,
    last_ledger: 0,
    ...NO_SETTINGS,
    domain: '',
    listed: 0,
    name: '',
    toml: '',
    deleted: 1,
    version,
  };
}

/**
 * Writes the `tokens` row of each of `p.tokens` into generation `p.generation`, all under `p.version`, as the state stood at
 * `p.atLedger` (spec 3.1 step 3, 3.2 step 5):
 *  - the counts and the supply from the newest live `token_lines` rows of the token (`holders`, `trust_lines`, the exact `supply` by
 *    `sumOf`, `last_ledger`);
 *  - the issuer's settings from its newest `account_states` row at or before `atLedger` (`issuer_ledger` 0 and the flags and the rate 0
 *    when it has none, or the row is a deletion);
 *  - the listing (`domain`, `listed`, `name`, `toml`): matched afresh against the issuer's account domain's stored toml for the
 *    tokens of the issuers in `p.rematch` (every token for `'all'`), and kept from the token's newest row otherwise; a token with no live
 *    row (none yet, or the newest is a deletion) is always matched;
 *  - a token with no live line gets a deleted row when it had a live one (and nothing when it had none).
 * The tokens go by chunks of `TOKENS_STATE_CHUNK`; each chunk is one insert. Idempotent: the rows are a function of the state. Resolves
 * once every chunk is written; `signal` is checked before the reads and the write of each chunk.
 */
export async function recomputeTokens(
  ch: ClickHouseService,
  p: {
    generation: number;
    tokens: readonly TokenKey[];
    atLedger: number;
    version: string;
    profile: Pick<NetworkProfile, 'tomlNetworkNames'>;
    rematch: 'all' | ReadonlySet<string>;
  },
  signal?: AbortSignal,
): Promise<void> {
  const { generation, atLedger, version, profile, rematch } = p;
  const distinct = [
    ...new Map(p.tokens.map((t) => [keyOf(t), { issuer: t.issuer, currency: t.currency }])).values(),
  ].sort((a, b) => (a.issuer === b.issuer ? (a.currency < b.currency ? -1 : 1) : a.issuer < b.issuer ? -1 : 1));
  for (const part of chunk(distinct, TOKENS_STATE_CHUNK)) {
    throwIfAborted(signal);
    const keys = { issuers: part.map((t) => t.issuer), currencies: part.map((t) => t.currency) };
    const [totalRows, storedRows] = await Promise.all([
      ch.query<TotalsRead>(TOKEN_TOTALS_SQL, { g: generation, ...keys }),
      ch.query<StoredTokenRead>(NEWEST_TOKENS_SQL, { g: generation, ...keys }),
    ]);
    const totals = new Map(totalRows.map((row) => [keyOf(row), row]));
    const stored = new Map(storedRows.map((row) => [keyOf(row), row]));
    const live = part.filter((t) => totals.has(keyOf(t)));

    // the issuers' settings: only the tokens that have a line need them
    throwIfAborted(signal);
    const settings = new Map<string, IssuerSettings>();
    const issuers = [...new Set(live.map((t) => t.issuer))];
    const settingRows =
      issuers.length === 0 ? [] : await ch.query<SettingsRead>(ISSUER_SETTINGS_SQL, { issuers, at: atLedger });
    for (const row of settingRows) {
      settings.set(
        row.account,
        Number(row.deleted) === 1
          ? NO_SETTINGS
          : {
              issuer_ledger: Number(row.ledger_index),
              issuer_flags: Number(row.flags),
              transfer_rate: Number(row.rate),
            },
      );
    }

    // the listing: matched for the tokens of the issuers to rematch and for those with no live row, kept for the others
    const keeps = (t: TokenKey): StoredTokenRead | undefined => {
      const row = stored.get(keyOf(t));
      return row !== undefined && Number(row.deleted) === 0 ? row : undefined;
    };
    const matched = live.filter((t) => rematch === 'all' || rematch.has(t.issuer) || keeps(t) === undefined);
    throwIfAborted(signal);
    const domains = await issuerDomains(ch, [...new Set(matched.map((t) => t.issuer))]);
    const currencies = await currenciesOf(
      ch,
      [...domains.values()].filter((domain) => domain !== ''),
    );
    const listings = new Map<string, TokenListing>();
    for (const t of matched) {
      const domain = domains.get(t.issuer) ?? '';
      listings.set(keyOf(t), tokenListing(t, domain, currencies.get(domain), profile));
    }

    const rows: TokensRow[] = part.flatMap((t): TokensRow[] => {
      const total = totals.get(keyOf(t));
      if (total === undefined) return keeps(t) === undefined ? [] : [deletedRow(generation, t, version)];
      const supply = sumOf(Number(total.n_unfit), total.supply_exact, total.supply_float);
      const kept = keeps(t);
      const listing = listings.get(keyOf(t)) ?? {
        domain: kept?.domain ?? '',
        listed: Number(kept?.listed ?? 0) === 1 ? 1 : 0,
        name: kept?.name ?? '',
        toml: kept?.toml ?? '',
      };
      return [
        {
          generation,
          issuer: t.issuer,
          currency: t.currency,
          code: currencyCode(t.currency) ?? '',
          holders: Number(total.n_holders),
          trust_lines: Number(total.n_lines),
          supply: supply.toFixed(),
          supply_f: supply.toNumber(),
          last_ledger: Number(total.newest_ledger),
          ...(settings.get(t.issuer) ?? NO_SETTINGS),
          ...listing,
          deleted: 0,
          version,
        },
      ];
    });
    if (rows.length === 0) continue;
    throwIfAborted(signal);
    await ch.insert(Table.Tokens, rows);
  }
}
