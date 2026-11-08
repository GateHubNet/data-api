import BigNumber from 'bignumber.js';
import type { TokenKey } from '../../aggregate/token-rules';
import { ClickHouseService } from '../../clickhouse/clickhouse.service';
import { TokenCheckpointHeadsRow } from '../../clickhouse/rows';
import { Table } from '../../clickhouse/tables';
import { EXACT_LIMIT, EXACT_SCALE, exactAmountOfText, exactSumColumns, exactSumOf } from '../../query/decimal';
import { checkpointLedgers, LedgerTotals } from '../checkpoint-rule';
import { TOKEN_HISTORY_CHECKPOINT_FLOOR, TOKEN_HISTORY_LEVELS_SLICE } from '../constants';
import { FLOWS_BY_TX_SQL } from '../flows';
import { checkpointAt, holdersAtSql } from '../holders-at';
import { closeHourOf, ledgersOfHour, levelsBefore, writeHourSets } from '../hour-sets';

/**
 * The build's `levels` phase (spec 4.6 phase 3): per token, in key order, the checkpoints and the hour rows of a generation, from its
 * change log up to `h1`. A token is built in ledger slices that end at the end of an hour, so no hour is split between two slices,
 * and a token's progress is read back from its own hour rows: a build stopped inside a token resumes where it was.
 */

const IN_ORDER = { optimize_aggregation_in_order: 1, max_block_size: '8192' } as const;

/** The token's key range of the change log of generation `g`: the condition every read of the phase starts from. */
const TOKEN_RANGE = 'generation = {g:UInt32} AND issuer = {issuer:String} AND currency = {currency:String}';

/** The next tokens of generation `g`'s change log after `after` (none: from the first), in key order, at most `n`. */
export async function nextLevelTokens(
  ch: ClickHouseService,
  g: number,
  after: TokenKey | undefined,
  n: number,
): Promise<TokenKey[]> {
  const rows = await ch.query<TokenKey>(
    `SELECT issuer, currency FROM ${Table.TokenHolderChanges}
      WHERE generation = {g:UInt32} AND (issuer > {issuer:String} OR (issuer = {issuer:String} AND currency > {currency:String}))
      GROUP BY issuer, currency
      ORDER BY issuer, currency
      LIMIT {n:UInt32}`,
    { g, issuer: after?.issuer ?? '', currency: after?.currency ?? '', n },
    IN_ORDER,
  );
  return rows.map((r) => ({ issuer: r.issuer, currency: r.currency }));
}

/** The options of `buildTokenLevels`. */
export interface TokenLevelsOptions {
  /** Ledgers with changes per slice (default `TOKEN_HISTORY_LEVELS_SLICE`); a slice grows to hold one whole hour. */
  slice?: number;
  /** The ledger the token is built up to already (default: read from its hour rows). */
  resumeFrom?: number;
  /** The checkpoint floor (default `TOKEN_HISTORY_CHECKPOINT_FLOOR`; the tests lower it). */
  floor?: number;
  /** The version of the hour rows (default: the clock). The build gives every row of a generation the same one. */
  version?: number | string;
  /** `max_threads` of the statements. */
  threads?: number;
  /** Told when a slice is summed in BigNumber because an amount did not fit the decimal. */
  onUnfit?: () => void;
  signal?: AbortSignal;
}

/** The ledger a token's levels are built up to in generation `g`: the newest ledger of its hour rows, 0 when it has none. */
export async function levelsDoneThrough(ch: ClickHouseService, g: number, token: TokenKey): Promise<number> {
  const row = await ch.queryOne<{ done: number | string }>(
    `SELECT max(last_ledger) AS done FROM ${Table.TokenHourly} WHERE ${TOKEN_RANGE}`,
    { g, ...token },
  );
  return Number(row?.done ?? 0);
}

/** A ledger with changes of the token: how many (each once), the change of its trust lines, and the hour it closes in. */
interface LedgerRead {
  ledger_index: number;
  hour: number;
  changes: string;
  lines: string;
}

/** The token's ledgers with changes in `({after}, {upTo}]`, each change counted once, in ledger order, at most `{limit}`. */
const LEDGER_TOTALS_SQL = `SELECT ledger_index, toUnixTimestamp(toStartOfHour(any(close_time))) AS hour, toString(count()) AS changes,
       toString(sum(toInt64(c_after) - toInt64(c_before))) AS lines
  FROM (SELECT ledger_index, tx_index, node_index, holder, any(close_time) AS close_time, any(counted_after) AS c_after,
               any(counted_before) AS c_before
          FROM ${Table.TokenHolderChanges}
         WHERE ${TOKEN_RANGE} AND ledger_index > {after:UInt32} AND ledger_index <= {upTo:UInt32}
         GROUP BY ledger_index, tx_index, node_index, holder)
 GROUP BY ledger_index
 ORDER BY ledger_index
 LIMIT {limit:UInt32}`;

/**
 * The next slice of the token after `after`: at most `slice` ledgers, cut back to the end of an hour when the read stopped at its cap.
 * When one hour alone has more ledgers, the slice is that whole hour.
 */
async function nextSlice(
  ch: ClickHouseService,
  g: number,
  token: TokenKey,
  after: number,
  upTo: number,
  slice: number,
): Promise<LedgerRead[]> {
  const params = { g, ...token, after, upTo };
  const read = await ch.query<LedgerRead>(LEDGER_TOTALS_SQL, { ...params, limit: slice }, IN_ORDER);
  if (read.length < slice) return read;
  const lastHour = read[read.length - 1].hour;
  const whole = read.filter((r) => r.hour < lastHour);
  if (whole.length > 0) return whole;
  const hour = await ledgersOfHour(ch, lastHour);
  const end = Math.min(upTo, hour?.last ?? upTo);
  return ch.query<LedgerRead>(LEDGER_TOTALS_SQL, { ...params, upTo: end, limit: 4_294_967_295 }, IN_ORDER);
}

/** Whether `Decimal256(30)` holds a supply whole, as `exactAmount`'s rule says. */
const fitsDecimal = (amount: string): boolean => {
  const n = new BigNumber(amount);
  return (n.decimalPlaces() ?? 0) <= EXACT_SCALE && n.abs().isLessThan(EXACT_LIMIT);
};

/** The hour rows of the slice's ledgers `[{from}, {to}]`, written in one statement with a running sum of the levels. */
const HOURS_SQL = `INSERT INTO ${Table.TokenHourly}
  (generation, issuer, currency, hour, supply, holders, trust_lines, issued, redeemed, clawed_back, transferred, transfers, changes,
   unknown_before, first_ledger, last_ledger, final, version)
WITH token_changes AS (
  SELECT * FROM ${Table.TokenHolderChanges}
   WHERE ${TOKEN_RANGE} AND ledger_index >= {from:UInt32} AND ledger_index <= {to:UInt32}
   LIMIT 1 BY ledger_index, tx_index, node_index, holder)
SELECT {g:UInt32}, {issuer:String}, {currency:String}, hour,
       toString(toDecimal256({base_supply:String}, ${EXACT_SCALE}) + sum(h_net) OVER w),
       toUInt64({base_holders:Int64} + sum(h_holders) OVER w),
       toUInt64({base_lines:Int64} + sum(h_lines) OVER w),
       toString(h_issued), toString(h_redeemed), toString(h_clawed), toString(h_transferred),
       h_transfers, h_changes, h_unknown, h_first, h_last,
       toUInt8(hour < toDateTime({final_before:UInt32}, 'UTC')), {version:UInt64}
  FROM (SELECT toStartOfHour(close_time) AS hour, sum(issued) AS h_issued, sum(redeemed) AS h_redeemed,
               sum(clawed_back) AS h_clawed, sum(transferred) AS h_transferred, toUInt32(sum(transfers)) AS h_transfers,
               toUInt32(sum(changes)) AS h_changes, toUInt32(sum(unknown_before)) AS h_unknown, min(ledger_index) AS h_first,
               max(ledger_index) AS h_last, sum(level_net) AS h_net, sum(holders_delta) AS h_holders, sum(lines_delta) AS h_lines
          FROM (${FLOWS_BY_TX_SQL})
         GROUP BY hour)
WINDOW w AS (ORDER BY hour ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)`;

/** How many changes of the slice's ledgers have an amount the decimal cannot hold. */
const SLICE_UNFIT_SQL = `SELECT toString(countIf(isNull(${exactAmountOfText('amount_before')}) OR isNull(${exactAmountOfText('amount_after')}))) AS n
  FROM ${Table.TokenHolderChanges}
 WHERE ${TOKEN_RANGE} AND ledger_index >= {from:UInt32} AND ledger_index <= {to:UInt32}`;

/**
 * Builds a token's checkpoints and hour rows in generation `g`, up to `upTo` (spec 4.6 phase 3). It streams the token's per-ledger
 * totals slice by slice (`LedgerTotals`), applies the checkpoint rule, and writes each checkpoint (its rows through `holdersAtSql`,
 * then its head) and the slice's hour rows (one `INSERT … SELECT` with a running sum of the levels, or `writeHourSets` in BigNumber
 * when an amount of the slice does not fit the decimal). Picks up after the ledger its hour rows reach, so a second run writes
 * nothing. Returns the checkpoints and hour rows written and the ledger the token is now built up to.
 */
export async function buildTokenLevels(
  ch: ClickHouseService,
  g: number,
  token: TokenKey,
  upTo: number,
  opts: TokenLevelsOptions = {},
): Promise<{ checkpoints: number; hours: number; doneThrough: number }> {
  const slice = opts.slice ?? TOKEN_HISTORY_LEVELS_SLICE;
  const floor = opts.floor ?? TOKEN_HISTORY_CHECKPOINT_FLOOR;
  const version = String(opts.version ?? Date.now());
  const settings = opts.threads === undefined ? {} : { max_threads: opts.threads };
  const base = { g, issuer: token.issuer, currency: token.currency };
  let after = opts.resumeFrom ?? (await levelsDoneThrough(ch, g, token));
  const done = { checkpoints: 0, hours: 0, doneThrough: after };
  if (after >= upTo) return done;

  // where the token stands at `after`: its last checkpoint and the changes since, its trust lines, and its first ledger
  let previousCp = after > 0 ? await checkpointAt(ch, g, token, after) : 0;
  const since = await ch.queryOne<{ n: string }>(
    `SELECT toString(count()) AS n FROM (SELECT 1 FROM ${Table.TokenHolderChanges}
      WHERE ${TOKEN_RANGE} AND ledger_index > {cp:UInt32} AND ledger_index <= {after:UInt32}
      GROUP BY ledger_index, tx_index, node_index, holder)`,
    { ...base, cp: previousCp, after },
  );
  let changesSince = Number(since?.n ?? 0);
  const firstRow = await ch.queryOne<{ ledger_index: number }>(
    `SELECT ledger_index FROM ${Table.TokenHolderChanges} WHERE ${TOKEN_RANGE} ORDER BY ledger_index LIMIT 1`,
    base,
  );
  const tokenFirst = Number(firstRow?.ledger_index ?? 0);
  const finalBefore = (await closeHourOf(ch, upTo)) ?? 0;
  let lines: number | undefined;

  for (;;) {
    if (opts.signal?.aborted) throw opts.signal.reason ?? new Error('aborted');
    const read = await nextSlice(ch, g, token, after, upTo, slice);
    if (read.length === 0) break;
    const firstHour = read[0].hour;
    const levels = await levelsBefore(ch, g, token, firstHour);
    lines ??= levels.trust_lines;

    // the checkpoint rule over the slice's ledgers
    const totals: LedgerTotals[] = read.map((r) => {
      lines! += Number(r.lines);
      return { ledger_index: r.ledger_index, changes: Number(r.changes), trust_lines_after: lines! };
    });
    const cps = new Set(checkpointLedgers(totals, changesSince, floor));
    for (const t of totals) {
      changesSince += t.changes;
      if (!cps.has(t.ledger_index)) continue;
      await writeCheckpoint(ch, g, token, t.ledger_index, previousCp, changesSince, tokenFirst, {
        threads: opts.threads,
        onUnfit: opts.onUnfit,
      });
      done.checkpoints++;
      previousCp = t.ledger_index;
      changesSince = 0;
    }

    // the slice's hour rows
    const from = after + 1;
    const to = read[read.length - 1].ledger_index;
    const unfit = await ch.queryOne<{ n: string }>(SLICE_UNFIT_SQL, { ...base, from, to });
    let exact = Number(unfit?.n ?? 0) === 0 && fitsDecimal(levels.supply);
    if (exact) {
      try {
        const summary = await ch.commandSummary(
          HOURS_SQL,
          {
            ...base,
            from,
            to,
            base_supply: levels.supply,
            base_holders: levels.holders,
            base_lines: levels.trust_lines,
            final_before: finalBefore,
            version,
          },
          { settings },
        );
        done.hours += summary.written_rows;
      } catch (e) {
        // a sum past what the decimal holds fails the statement (DECIMAL_OVERFLOW): the slice is summed in BigNumber instead
        if (!/DECIMAL_OVERFLOW|overflow/i.test(String((e as Error)?.message))) throw e;
        exact = false;
      }
    }
    if (!exact) {
      opts.onUnfit?.();
      const hours = [...new Set(read.map((r) => r.hour))];
      await writeHourSets(ch, g, token, hours.map((h) => new Date(h * 1000)), upTo, { version });
      done.hours += hours.length;
    }
    after = to;
    done.doneThrough = to;
    if (to >= upTo) break;
  }
  return done;
}

/**
 * Writes a checkpoint of a token at `ledger` in generation `g` (spec 4.3): its rows, the fold of `holdersAtSql` from the previous
 * checkpoint `previousCp` (0: none) to `ledger`, then its head, which commits it. `changesSince` is the token's changes since the
 * previous checkpoint, `tokenFirst` the ledger of its first change. The build and the live windows both write checkpoints with it.
 */
export async function writeCheckpoint(
  ch: ClickHouseService,
  g: number,
  token: TokenKey,
  ledger: number,
  previousCp: number,
  changesSince: number,
  tokenFirst: number,
  o: { threads?: number; onUnfit?: () => void } = {},
): Promise<void> {
  await ch.command(
    `INSERT INTO ${Table.TokenCheckpoints}
       (generation, issuer, currency, checkpoint_ledger, holder, amount, escrowed, \`limit\`, frozen, authorized, order_exp,
        order_mant, first_ledger, last_ledger)
     SELECT {g:UInt32}, {issuer:String}, {currency:String}, {n:UInt32}, holder, amount, escrowed, \`limit\`, frozen, authorized,
            exp, mant, first_ledger, last_ledger
       FROM (${holdersAtSql()})`,
    { g, issuer: token.issuer, currency: token.currency, cp: previousCp, n: ledger },
    { settings: o.threads === undefined ? {} : { max_threads: o.threads } },
  );
  await writeCheckpointHead(ch, g, token, ledger, changesSince, tokenFirst, o.onUnfit);
}

/** Writes the head of a checkpoint just written: its totals from its rows (the supply exact), the changes since the previous one. */
async function writeCheckpointHead(
  ch: ClickHouseService,
  g: number,
  token: TokenKey,
  ledger: number,
  changesSince: number,
  tokenFirst: number,
  onUnfit?: () => void,
): Promise<void> {
  const params = { g, ...token, cp: ledger };
  const rows = `SELECT amount FROM ${Table.TokenCheckpoints}
     WHERE ${TOKEN_RANGE} AND checkpoint_ledger = {cp:UInt32} LIMIT 1 BY holder`;
  const sums = await ch.queryOne<{ s_exact: string | null; s_unfit: number; holders: string; lines: string }>(
    `SELECT ${exactSumColumns('amount', 's')}, toString(countIf(amount != '0')) AS holders, toString(count()) AS lines FROM (${rows})`,
    params,
  );
  const supply = await exactSumOf(sums?.s_exact ?? null, Number(sums?.s_unfit ?? 0), async () => {
    onUnfit?.();
    return (await ch.query<{ amount: string }>(rows, params)).map((r) => r.amount);
  });
  const head: TokenCheckpointHeadsRow = {
    generation: g,
    issuer: token.issuer,
    currency: token.currency,
    checkpoint_ledger: ledger,
    supply: supply.isZero() ? '0' : supply.toFixed(),
    holders: sums?.holders ?? '0',
    trust_lines: sums?.lines ?? '0',
    changes_since: String(changesSince),
    first_ledger: tokenFirst,
  };
  await ch.insert(Table.TokenCheckpointHeads, [head]);
}

// ---------------------------------------------------------------------------------------------------------------------
// Small tokens, many at a time
// ---------------------------------------------------------------------------------------------------------------------

/** The key range of the tokens `[{first_issuer}.{first_currency}, {last_issuer}.{last_currency}]` of a generation's change log. */
const TOKENS_RANGE = `generation = {g:UInt32}
   AND (issuer > {first_issuer:String} OR (issuer = {first_issuer:String} AND currency >= {first_currency:String}))
   AND (issuer < {last_issuer:String} OR (issuer = {last_issuer:String} AND currency <= {last_currency:String}))`;

/** The hour rows of the small tokens `{keys}` (`issuer|currency`) up to `{to}`, from their first change: one statement for them all. */
const SMALL_HOURS_SQL = `INSERT INTO ${Table.TokenHourly}
  (generation, issuer, currency, hour, supply, holders, trust_lines, issued, redeemed, clawed_back, transferred, transfers, changes,
   unknown_before, first_ledger, last_ledger, final, version)
WITH token_changes AS (
  SELECT * FROM ${Table.TokenHolderChanges}
   WHERE ${TOKENS_RANGE} AND ledger_index <= {to:UInt32} AND concat(issuer, '|', currency) IN {keys:Array(String)}
   LIMIT 1 BY issuer, currency, ledger_index, tx_index, node_index, holder)
SELECT {g:UInt32}, issuer, currency, hour,
       toString(sum(h_net) OVER w), toUInt64(sum(h_holders) OVER w), toUInt64(sum(h_lines) OVER w),
       toString(h_issued), toString(h_redeemed), toString(h_clawed), toString(h_transferred),
       h_transfers, h_changes, h_unknown, h_first, h_last,
       toUInt8(hour < toDateTime({final_before:UInt32}, 'UTC')), {version:UInt64}
  FROM (SELECT issuer, currency, toStartOfHour(close_time) AS hour, sum(issued) AS h_issued, sum(redeemed) AS h_redeemed,
               sum(clawed_back) AS h_clawed, sum(transferred) AS h_transferred, toUInt32(sum(transfers)) AS h_transfers,
               toUInt32(sum(changes)) AS h_changes, toUInt32(sum(unknown_before)) AS h_unknown, min(ledger_index) AS h_first,
               max(ledger_index) AS h_last, sum(level_net) AS h_net, sum(holders_delta) AS h_holders, sum(lines_delta) AS h_lines
          FROM (${FLOWS_BY_TX_SQL})
         GROUP BY issuer, currency, hour)
WINDOW w AS (PARTITION BY issuer, currency ORDER BY hour ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)`;

/**
 * Builds the hour rows of the small tokens of `tokens` (a batch of `nextLevelTokens`, in key order) in generation `g` up to `upTo`,
 * in one statement per group of at most `opts.slice` changes, and returns the others. A token is small when it has fewer changes
 * than the checkpoint floor, so it can have no checkpoint, and every amount of it fits the decimal; its rows are then those
 * `buildTokenLevels` writes, from levels of 0 at its first change. The big ones (`big`) are left to `buildTokenLevels`; a token with no
 * change up to `upTo` is in neither. A batch run again writes the same rows under the same version.
 */
export async function buildSmallTokenLevels(
  ch: ClickHouseService,
  g: number,
  tokens: TokenKey[],
  upTo: number,
  opts: TokenLevelsOptions = {},
): Promise<{ big: TokenKey[]; hours: number }> {
  if (tokens.length === 0) return { big: [], hours: 0 };
  const floor = opts.floor ?? TOKEN_HISTORY_CHECKPOINT_FLOOR;
  const slice = opts.slice ?? TOKEN_HISTORY_LEVELS_SLICE;
  const settings = opts.threads === undefined ? {} : { max_threads: opts.threads };
  const range = {
    g,
    first_issuer: tokens[0].issuer,
    first_currency: tokens[0].currency,
    last_issuer: tokens[tokens.length - 1].issuer,
    last_currency: tokens[tokens.length - 1].currency,
  };
  const stats = await ch.query<{ issuer: string; currency: string; n: string; unfit: string }>(
    `SELECT issuer, currency, toString(count()) AS n,
            toString(countIf(isNull(${exactAmountOfText('amount_before')}) OR isNull(${exactAmountOfText('amount_after')}))) AS unfit
       FROM ${Table.TokenHolderChanges}
      WHERE ${TOKENS_RANGE} AND ledger_index <= {upTo:UInt32}
      GROUP BY issuer, currency`,
    { ...range, upTo },
  );
  const byKey = new Map(stats.map((s) => [`${s.issuer}|${s.currency}`, s]));
  const big: TokenKey[] = [];
  const groups: string[][] = [];
  let group: string[] = [];
  let size = 0;
  for (const token of tokens) {
    const key = `${token.issuer}|${token.currency}`;
    const s = byKey.get(key);
    if (s === undefined) continue;
    const n = Number(s.n);
    if (n >= floor || Number(s.unfit) > 0) {
      big.push(token);
      continue;
    }
    if (group.length > 0 && size + n > slice) {
      groups.push(group);
      group = [];
      size = 0;
    }
    group.push(key);
    size += n;
  }
  if (group.length > 0) groups.push(group);

  let hours = 0;
  if (groups.length > 0) {
    const finalBefore = (await closeHourOf(ch, upTo)) ?? 0;
    const version = String(opts.version ?? Date.now());
    for (const keys of groups) {
      if (opts.signal?.aborted) throw opts.signal.reason ?? new Error('aborted');
      const summary = await ch.commandSummary(
        SMALL_HOURS_SQL,
        { ...range, to: upTo, keys, final_before: finalBefore, version },
        { settings },
      );
      hours += summary.written_rows;
    }
  }
  return { big, hours };
}
