import BigNumber from 'bignumber.js';
import type { TokenKey } from '../aggregate/token-rules';
import { ClickHouseService } from '../clickhouse/clickhouse.service';
import { Table } from '../clickhouse/tables';
import { EXACT_SCALE, exactAmountOfText, exactSumColumns } from '../query/decimal';
import { isMptIssuanceId } from '../util/mpt';
import { snapshotDigest } from './digest';
import { ChangeAmounts, flowsOfTransaction } from './flows';
import { checkpointAt, holdersAt, holdersAtSql, totalsAt } from './holders-at';
import { closeHourOf } from './hour-sets';

/**
 * The reads of the token history's routes (spec 3, 5) that are not the fold: the tokens of an issuer, the flows and the DEX figures
 * of a window. Each starts from a token's (or an issuer's) key prefix and is bounded (spec 7); the sums are exact, in BigNumber.
 */

const HOUR = 3_600;
const DAY = 86_400;
/** A side with no change sums to NULL over the nullable decimals: read as 0. */
const DECIMAL_ZERO = `toDecimal256(0, ${EXACT_SCALE})`;
const text = (n: BigNumber): string => (n.isZero() ? '0' : n.toFixed());

/** A token of an issuer at a ledger (spec 5.1). */
export interface IssuerToken {
  currency: string;
  kind: 'issued' | 'mpt';
  supply: string;
  holders: number;
  trust_lines: number;
  first_ledger: number;
  last_ledger: number;
}

/** How many tokens' totals are read at once for a page of an issuer's tokens. */
const ISSUER_TOKENS_CONCURRENCY = 8;

/**
 * The tokens of `issuer` with a change at or before `n` in generation `g`, by `currency`, after `page.after`, at most `page.limit`,
 * each with its totals by spec 3.2 (`totalsAt`, no fold). The list is read from the issuer's prefix of `token_hourly` (one row per
 * token and hour with a change), not from the change log. An issuance ID is an MPT.
 */
export async function issuerTokensAt(
  ch: ClickHouseService,
  g: number,
  issuer: string,
  n: number,
  page: { after?: string; limit: number },
): Promise<IssuerToken[]> {
  const rows = await ch.query<{ currency: string }>(
    `SELECT currency FROM ${Table.TokenHourly}
      WHERE generation = {g:UInt32} AND issuer = {issuer:String} AND currency > {after:String} AND first_ledger <= {n:UInt32}
      GROUP BY currency
      ORDER BY currency
      LIMIT {limit:UInt32}`,
    { g, issuer, after: page.after ?? '', n, limit: page.limit },
  );
  const out: IssuerToken[] = new Array(rows.length);
  for (let i = 0; i < rows.length; i += ISSUER_TOKENS_CONCURRENCY) {
    await Promise.all(
      rows.slice(i, i + ISSUER_TOKENS_CONCURRENCY).map(async ({ currency }, j) => {
        const t = await totalsAt(ch, g, { issuer, currency }, n);
        out[i + j] = {
          currency,
          kind: isMptIssuanceId(currency) ? 'mpt' : 'issued',
          supply: t.supply,
          holders: t.holders,
          trust_lines: t.trust_lines,
          first_ledger: t.first_ledger ?? 0,
          last_ledger: t.last_ledger ?? 0,
        };
      }),
    );
  }
  return out;
}

/** The flows of a window (spec 1), summed over its transactions, with its count of changes. */
export interface WindowFlows {
  issued: string;
  redeemed: string;
  clawed_back: string;
  transferred: string;
  transfers: number;
  changes: number;
  unknown_before: number;
}

/** A sum of flows, in BigNumber until it is served. */
class FlowsSum {
  issued = new BigNumber(0);
  redeemed = new BigNumber(0);
  clawed_back = new BigNumber(0);
  transferred = new BigNumber(0);
  transfers = 0;
  changes = 0;
  unknown_before = 0;

  add(f: { issued: string; redeemed: string; clawed_back: string; transferred: string; transfers: number }): void {
    this.issued = this.issued.plus(f.issued);
    this.redeemed = this.redeemed.plus(f.redeemed);
    this.clawed_back = this.clawed_back.plus(f.clawed_back);
    this.transferred = this.transferred.plus(f.transferred);
    this.transfers += f.transfers;
  }

  served(): WindowFlows {
    return {
      issued: text(this.issued),
      redeemed: text(this.redeemed),
      clawed_back: text(this.clawed_back),
      transferred: text(this.transferred),
      transfers: this.transfers,
      changes: this.changes,
      unknown_before: this.unknown_before,
    };
  }
}

interface EdgeChange {
  ledger_index: number;
  tx_index: number;
  close_time: number | string;
  clawback: number;
  amount_before: string;
  amount_after: string;
  before_known: number;
}

/** A part of a window's flows with its time (unix seconds): a whole hour's row, or one transaction of an edge hour. */
export interface TimedFlows {
  time: number;
  issued: string;
  redeemed: string;
  clawed_back: string;
  transferred: string;
  transfers: number;
  changes: number;
  unknown_before: number;
}

/**
 * The parts of a token's flows in `[fromLedger, toLedger]` (spec 3.5): the `token_hourly` rows of the hours wholly inside it (at the
 * hour's start), and each transaction of its two edge hours, from the change log grouped by transaction (`flowsOfTransaction`), at its
 * close time. So the read is bounded by the window's hours and two hours of the token's changes, wherever the window lies. A
 * transaction is in one ledger, so in one hour.
 */
export async function windowFlowParts(
  ch: ClickHouseService,
  g: number,
  token: TokenKey,
  fromLedger: number,
  toLedger: number,
): Promise<TimedFlows[]> {
  if (fromLedger > toLedger) return [];
  const [fromHour, toHour] = await Promise.all([closeHourOf(ch, fromLedger), closeHourOf(ch, toLedger)]);
  if (fromHour === undefined || toHour === undefined) {
    throw new Error(`windowFlows: ledger ${fromHour === undefined ? fromLedger : toLedger} is not stored`);
  }
  const params = { g, issuer: token.issuer, currency: token.currency, fromLedger, toLedger, fromHour, toHour };
  const prefix = `generation = {g:UInt32} AND issuer = {issuer:String} AND currency = {currency:String}`;
  // the edges: the window's part of its first and of its last hour (one read when they are the same hour)
  const edgeCondition =
    fromHour === toHour
      ? 'TRUE'
      : `(close_time < toDateTime({fromHour:UInt32} + ${HOUR}, 'UTC') OR close_time >= toDateTime({toHour:UInt32}, 'UTC'))`;
  const [edges, hours] = await Promise.all([
    ch.query<EdgeChange>(
      `SELECT ledger_index, tx_index, toUnixTimestamp(close_time) AS close_time, clawback, amount_before, amount_after, before_known
         FROM ${Table.TokenHolderChanges}
        WHERE ${prefix} AND ledger_index >= {fromLedger:UInt32} AND ledger_index <= {toLedger:UInt32} AND ${edgeCondition}
        ORDER BY ledger_index, tx_index, node_index, holder
        LIMIT 1 BY ledger_index, tx_index, node_index, holder`,
      params,
    ),
    fromHour === toHour || toHour - fromHour === HOUR
      ? Promise.resolve([])
      : ch.query<{
          hour: number | string;
          issued: string;
          redeemed: string;
          clawed_back: string;
          transferred: string;
          transfers: number | string;
          changes: number | string;
          unknown_before: number | string;
        }>(
          `SELECT toUnixTimestamp(hour) AS hour, issued, redeemed, clawed_back, transferred, transfers, changes, unknown_before
             FROM ${Table.TokenHourly}
            WHERE ${prefix} AND hour > toDateTime({fromHour:UInt32}, 'UTC') AND hour < toDateTime({toHour:UInt32}, 'UTC')
            ORDER BY hour, version DESC
            LIMIT 1 BY hour`,
          params,
        ),
  ]);
  const parts: TimedFlows[] = hours.map((h) => ({
    time: Number(h.hour),
    issued: h.issued,
    redeemed: h.redeemed,
    clawed_back: h.clawed_back,
    transferred: h.transferred,
    transfers: Number(h.transfers),
    changes: Number(h.changes),
    unknown_before: Number(h.unknown_before),
  }));
  let tx: { key: string; time: number; clawback: boolean; changes: ChangeAmounts[] } | undefined;
  const flush = (): void => {
    if (tx === undefined) return;
    const f = flowsOfTransaction(tx.changes, tx.clawback);
    parts.push({ time: tx.time, ...f, changes: tx.changes.length });
  };
  for (const c of edges) {
    const key = `${c.ledger_index}:${c.tx_index}`;
    if (tx?.key !== key) {
      flush();
      tx = { key, time: Number(c.close_time), clawback: false, changes: [] };
    }
    tx.clawback ||= Number(c.clawback) === 1;
    tx.changes.push({ before: c.amount_before, after: c.amount_after, beforeKnown: Number(c.before_known) === 1 });
  }
  flush();
  return parts.sort((a, b) => a.time - b.time);
}

/** A sum of flow parts. */
export function sumFlows(parts: readonly Omit<TimedFlows, 'time'>[]): WindowFlows {
  const sum = new FlowsSum();
  for (const p of parts) {
    sum.add(p);
    sum.changes += p.changes;
    sum.unknown_before += p.unknown_before;
  }
  return sum.served();
}

/** The flows of a token's changes in `[fromLedger, toLedger]` (spec 3.5): the sum of `windowFlowParts`. */
export async function windowFlows(
  ch: ClickHouseService,
  g: number,
  token: TokenKey,
  fromLedger: number,
  toLedger: number,
): Promise<WindowFlows> {
  return sumFlows(await windowFlowParts(ch, g, token, fromLedger, toLedger));
}

/** The DEX figures of a token over whole hours (spec 2.4, 5.2, 5.6). */
export interface WindowDex {
  exchanged: string;
  trades: number;
  /** The end of the newest hour of the window with its sentinel: the figures are those of the hours up to it. */
  through: Date;
  /** Whether every hour of the window has its sentinel. */
  complete: boolean;
}

const DEX_SENTINEL = "issuer = '' AND currency = ''";

/** A DEX hour of a token: an hour with its sentinel, and the token's figures in it (0 when it had no trade). */
export interface DexHour {
  hour: number;
  exchanged: string;
  trades: number;
}

/**
 * The DEX hours of a token in `[fromHour, toHour)` (unix seconds, whole hours), from `token_hourly_dex`: the hours with a sentinel
 * only, in order, a token row counting when it is of its hour's sentinel write or a newer one (a row older than the sentinel is of a
 * write the newer one replaced).
 */
export async function dexHoursOfWindow(
  ch: ClickHouseService,
  token: TokenKey,
  fromHour: number,
  toHour: number,
): Promise<DexHour[]> {
  if (fromHour >= toHour) return [];
  const range = `hour >= toDateTime({fromHour:UInt32}, 'UTC') AND hour < toDateTime({toHour:UInt32}, 'UTC')`;
  const params = { issuer: token.issuer, currency: token.currency, fromHour, toHour };
  const [sentinels, rows] = await Promise.all([
    ch.query<{ hour: number | string; version: string }>(
      `SELECT toUnixTimestamp(hour) AS hour, toString(version) AS version FROM ${Table.TokenHourlyDex}
        WHERE ${DEX_SENTINEL} AND ${range}
        ORDER BY hour, version DESC
        LIMIT 1 BY hour`,
      params,
    ),
    ch.query<{ hour: number | string; exchanged: string; trades: number | string; version: string }>(
      `SELECT toUnixTimestamp(hour) AS hour, exchanged, trades, toString(version) AS version FROM ${Table.TokenHourlyDex}
        WHERE issuer = {issuer:String} AND currency = {currency:String} AND ${range}
        ORDER BY hour, version DESC
        LIMIT 1 BY hour`,
      params,
    ),
  ]);
  const row = new Map(rows.map((r) => [Number(r.hour), r]));
  return sentinels.map((s) => {
    const hour = Number(s.hour);
    const r = row.get(hour);
    const counts = r !== undefined && BigInt(r.version) >= BigInt(s.version);
    return { hour, exchanged: counts ? r.exchanged : '0', trades: counts ? Number(r.trades) : 0 };
  });
}

/** The DEX figures of DEX hours summed; `undefined` for none. `complete` says whether they are every hour of `[fromHour, toHour)`. */
export function sumDex(hours: readonly DexHour[], fromHour: number, toHour: number): WindowDex | undefined {
  if (hours.length === 0) return undefined;
  let exchanged = new BigNumber(0);
  let trades = 0;
  for (const h of hours) {
    exchanged = exchanged.plus(h.exchanged);
    trades += h.trades;
  }
  return {
    exchanged: text(exchanged),
    trades,
    through: new Date((Math.max(...hours.map((h) => h.hour)) + HOUR) * 1000),
    complete: hours.length === (toHour - fromHour) / HOUR,
  };
}

/**
 * The DEX figures of a token over the hours `[fromHour, toHour)` (unix seconds, whole hours): the sum of `dexHoursOfWindow`,
 * `undefined` when no hour of the window has a sentinel.
 */
export async function dexOfWindow(
  ch: ClickHouseService,
  token: TokenKey,
  fromHour: number,
  toHour: number,
): Promise<WindowDex | undefined> {
  return sumDex(await dexHoursOfWindow(ch, token, fromHour, toHour), fromHour, toHour);
}

// -- periods -----------------------------------------------------------------------------------------------------------------

export type PeriodInterval = 'hour' | 'day' | 'month';

/** The start (unix seconds, UTC) of the period of `interval` that holds `t`. */
export function periodStart(t: number, interval: PeriodInterval): number {
  if (interval === 'hour') return Math.floor(t / HOUR) * HOUR;
  if (interval === 'day') return Math.floor(t / DAY) * DAY;
  const d = new Date(t * 1000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000;
}

/** The start of the period after the one that starts at `p`. */
export function nextPeriod(p: number, interval: PeriodInterval): number {
  if (interval === 'hour') return p + HOUR;
  if (interval === 'day') return p + DAY;
  const d = new Date(p * 1000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / 1000;
}

/** A period of a window's flows (spec 5.6), and its DEX figures when every hour of the window has its sentinel. */
export interface FlowsPeriod extends WindowFlows {
  start: number;
  dex?: { exchanged: string; trades: number };
}

/**
 * The flows of a token over a window (spec 5.6): the window is `[start, end)` (unix seconds) and its ledgers `[fromLedger, toLedger]`;
 * `periods` is every period of `interval` from the one holding `start` to the one holding `end − 1`, the empty ones included, and
 * `totals` their sum. The DEX figures are there, in the totals and in every period, only when every whole hour of the window has
 * its sentinel (`dex`).
 */
export async function flowsPeriods(
  ch: ClickHouseService,
  g: number,
  token: TokenKey,
  o: { fromLedger: number; toLedger: number; start: number; end: number; interval: PeriodInterval },
): Promise<{ totals: WindowFlows; periods: FlowsPeriod[]; dex?: WindowDex }> {
  const fromHour = Math.ceil(o.start / HOUR) * HOUR;
  const toHour = Math.floor(o.end / HOUR) * HOUR;
  const [parts, dexHours] = await Promise.all([
    windowFlowParts(ch, g, token, o.fromLedger, o.toLedger),
    dexHoursOfWindow(ch, token, fromHour, toHour),
  ]);
  const dex = sumDex(dexHours, fromHour, toHour);
  const complete = dex?.complete === true;
  const periods: FlowsPeriod[] = [];
  let i = 0;
  let k = 0;
  for (let p = periodStart(o.start, o.interval); p < o.end; p = nextPeriod(p, o.interval)) {
    const next = nextPeriod(p, o.interval);
    const own: TimedFlows[] = [];
    while (i < parts.length && parts[i].time < next) own.push(parts[i++]);
    const hours: DexHour[] = [];
    while (k < dexHours.length && dexHours[k].hour < next) hours.push(dexHours[k++]);
    const pdex = complete ? sumDex(hours, 0, 0) : undefined;
    periods.push({
      start: p,
      ...sumFlows(own),
      ...(complete && { dex: { exchanged: pdex?.exchanged ?? '0', trades: pdex?.trades ?? 0 } }),
    });
  }
  return { totals: sumFlows(parts), periods, ...(complete && { dex }) };
}

// -- counterparties ----------------------------------------------------------------------------------------------------------

export interface Counterparty {
  account: string;
  received: string;
  sent: string;
  net: string;
  changes: number;
}

/**
 * The `n` holders of a token with the largest `received + sent` in `[fromLedger, toLedger]` (spec 5.6), then by account: what each
 * line's amount rose by (`received`) and fell by (`sent`) over its changes whose earlier state is known, and the number of its
 * changes. Read from the token's changes in the window, summed in the decimal, or in BigNumber when an amount does not fit.
 */
export async function topCounterparties(
  ch: ClickHouseService,
  g: number,
  token: TokenKey,
  fromLedger: number,
  toLedger: number,
  n: number,
): Promise<Counterparty[]> {
  if (fromLedger > toLedger || n <= 0) return [];
  const params = { g, issuer: token.issuer, currency: token.currency, fromLedger, toLedger };
  const changes = `SELECT holder, before_known, amount_before, amount_after FROM ${Table.TokenHolderChanges}
     WHERE generation = {g:UInt32} AND issuer = {issuer:String} AND currency = {currency:String}
       AND ledger_index >= {fromLedger:UInt32} AND ledger_index <= {toLedger:UInt32}
     LIMIT 1 BY ledger_index, tx_index, node_index, holder`;
  const rows = await ch.query<{
    holder: string;
    received: string;
    sent: string;
    changes: number | string;
    unfit: number | string;
  }>(
    `SELECT holder, toString(ifNull(sumIf(d, d > 0), ${DECIMAL_ZERO})) AS received,
            toString(ifNull(sumIf(-d, d < 0), ${DECIMAL_ZERO})) AS sent,
            toUInt32(count()) AS changes, toUInt32(countIf(before_known = 1 AND isNull(d))) AS unfit
       FROM (SELECT holder, before_known,
                    if(before_known = 1, ${exactAmountOfText('amount_after')} - ${exactAmountOfText('amount_before')},
                       toDecimal256(0, ${EXACT_SCALE})) AS d
               FROM (${changes}))
      GROUP BY holder`,
    params,
  );
  let sums: { account: string; received: BigNumber; sent: BigNumber; changes: number }[];
  if (rows.every((r) => Number(r.unfit) === 0)) {
    sums = rows.map((r) => ({
      account: r.holder,
      received: new BigNumber(r.received),
      sent: new BigNumber(r.sent),
      changes: Number(r.changes),
    }));
  } else {
    const byHolder = new Map<string, { account: string; received: BigNumber; sent: BigNumber; changes: number }>();
    for (const c of await ch.query<{
      holder: string;
      before_known: number;
      amount_before: string;
      amount_after: string;
    }>(changes, params)) {
      const s = byHolder.get(c.holder) ?? {
        account: c.holder,
        received: new BigNumber(0),
        sent: new BigNumber(0),
        changes: 0,
      };
      s.changes += 1;
      if (Number(c.before_known) === 1) {
        const d = new BigNumber(c.amount_after).minus(c.amount_before);
        if (d.gt(0)) s.received = s.received.plus(d);
        else s.sent = s.sent.minus(d);
      }
      byHolder.set(c.holder, s);
    }
    sums = [...byHolder.values()];
  }
  return sums
    .sort((a, b) => b.received.plus(b.sent).comparedTo(a.received.plus(a.sent)) || (a.account < b.account ? -1 : 1))
    .slice(0, n)
    .map((s) => ({
      account: s.account,
      received: text(s.received),
      sent: text(s.sent),
      net: text(s.received.minus(s.sent)),
      changes: s.changes,
    }));
}

// -- the supply series -------------------------------------------------------------------------------------------------------

/** A row of the supply series (spec 5.3): the levels at its end, the flows in it, and the levels without the excluded holders. */
export interface SupplyPoint {
  /** The bucket's start, or the ledger's close (unix seconds). */
  time: number;
  /** The ledger the levels are as of: the token's newest change at or before the bucket's end, or the row's ledger. */
  ledger_index: number;
  supply: string;
  holders: number;
  trust_lines: number;
  issued: string;
  redeemed: string;
  clawed_back: string;
  net: string;
  unknown_before: number;
  without_excluded?: { supply: string; holders: number; trust_lines: number };
}

export type SeriesInterval = 'hour' | 'day' | 'ledger';

/** The excluded holders' lines, as the series walks forward: the amount (0 when the line does not count) and whether it counts. */
class ExcludedLines {
  private readonly lines = new Map<string, { amount: BigNumber; counted: boolean }>();

  constructor(start: readonly { holder: string; amount: string; counted: boolean }[]) {
    for (const l of start) this.lines.set(l.holder, { amount: new BigNumber(l.amount), counted: l.counted });
  }

  apply(holder: string, amountAfter: string, countedAfter: boolean): void {
    this.lines.set(holder, { amount: new BigNumber(amountAfter), counted: countedAfter });
  }

  /** The levels without the excluded holders. */
  without(levels: { supply: BigNumber; holders: number; trust_lines: number }): SupplyPoint['without_excluded'] {
    let supply = levels.supply;
    let holders = levels.holders;
    let lines = levels.trust_lines;
    for (const l of this.lines.values()) {
      if (!l.counted) continue;
      lines -= 1;
      if (l.amount.gt(0)) {
        supply = supply.minus(l.amount);
        holders -= 1;
      }
    }
    return { supply: text(supply), holders, trust_lines: lines };
  }
}

interface SeriesChange {
  ledger_index: number;
  tx_index: number;
  holder: string;
  close_time: number | string;
  clawback: number;
  amount_before: string;
  amount_after: string;
  counted_before: number;
  counted_after: number;
  before_known: number;
}

const SERIES_CHANGE_COLUMNS = `ledger_index, tx_index, holder, toUnixTimestamp(close_time) AS close_time, clawback, amount_before,
  amount_after, counted_before, counted_after, before_known`;

/** The last stored ledger that closed before `t` (unix seconds), `undefined` when none did. */
async function lastLedgerBefore(ch: ClickHouseService, t: number): Promise<number | undefined> {
  const row = await ch.queryOne<{ ledger_index: number }>(
    `SELECT ledger_index FROM ${Table.Ledgers} WHERE close_time < toDateTime({t:UInt32}, 'UTC') ORDER BY ledger_index DESC LIMIT 1`,
    { t },
  );
  return row === undefined ? undefined : Number(row.ledger_index);
}

/** The excluded holders' lines at `n`, from the fold of their own lines. */
async function excludedAt(ch: ClickHouseService, g: number, token: TokenKey, n: number | undefined, exclude: string[]) {
  if (n === undefined) return new ExcludedLines([]);
  return new ExcludedLines(await holdersAt(ch, g, token, n, { holders: exclude }));
}

/**
 * A page of the supply series of a token (spec 5.3), `limit + 1` rows at most, so that the caller can tell there is more:
 *  - `hour` and `day`: every bucket from `from` to `to` (bucket starts, unix seconds, both included), after the bucket `after` in the
 *    order asked for; the levels at the bucket's end carried forward from the token's hour rows, the flows the sum of its hours;
 *  - `ledger`: the ledgers of `[from, to]` with a change of the token, after the ledger `after`; the levels after each from the totals
 *    before the page and the page's changes, the flows of its transactions.
 * With `exclude`, every row has `without_excluded`: the excluded holders' lines at the page's start (`holdersAt`), walked forward over
 * their changes in the page.
 */
export async function supplySeries(
  ch: ClickHouseService,
  g: number,
  token: TokenKey,
  o: {
    interval: SeriesInterval;
    from: number;
    to: number;
    /** The answer's ledger: no level or change above it. */
    toLedger: number;
    descending: boolean;
    after?: number;
    limit: number;
    exclude?: string[];
  },
): Promise<SupplyPoint[]> {
  const rows = o.interval === 'ledger' ? await ledgerSeries(ch, g, token, o) : await bucketSeries(ch, g, token, o);
  return o.descending ? rows.reverse() : rows;
}

const prefixOf = `generation = {g:UInt32} AND issuer = {issuer:String} AND currency = {currency:String}`;

async function bucketSeries(
  ch: ClickHouseService,
  g: number,
  token: TokenKey,
  o: Parameters<typeof supplySeries>[3],
): Promise<SupplyPoint[]> {
  const size = o.interval === 'hour' ? HOUR : DAY;
  const buckets: number[] = [];
  if (o.descending) {
    for (let b = o.after === undefined ? o.to : o.after - size; b >= o.from && buckets.length <= o.limit; b -= size)
      buckets.push(b);
    buckets.reverse();
  } else {
    for (let b = o.after === undefined ? o.from : o.after + size; b <= o.to && buckets.length <= o.limit; b += size)
      buckets.push(b);
  }
  if (buckets.length === 0) return [];
  const lo = buckets[0];
  const hi = buckets[buckets.length - 1] + size;
  const params = { g, issuer: token.issuer, currency: token.currency, lo, hi, toLedger: o.toLedger };
  type HourRead = {
    hour: number | string;
    supply: string;
    holders: number | string;
    trust_lines: number | string;
    issued: string;
    redeemed: string;
    clawed_back: string;
    unknown_before: number | string;
    last_ledger: number | string;
  };
  const columns = `toUnixTimestamp(hour) AS hour, supply, holders, trust_lines, issued, redeemed, clawed_back, unknown_before, last_ledger`;
  const [carryRow, hours, startLedger] = await Promise.all([
    ch.queryOne<HourRead>(
      `SELECT ${columns} FROM ${Table.TokenHourly}
        WHERE ${prefixOf} AND hour < toDateTime({lo:UInt32}, 'UTC')
        ORDER BY hour DESC, version DESC LIMIT 1`,
      params,
    ),
    ch.query<HourRead>(
      `SELECT ${columns} FROM ${Table.TokenHourly}
        WHERE ${prefixOf} AND hour >= toDateTime({lo:UInt32}, 'UTC') AND hour < toDateTime({hi:UInt32}, 'UTC')
        ORDER BY hour, version DESC LIMIT 1 BY hour`,
      params,
    ),
    o.exclude === undefined ? Promise.resolve(undefined) : lastLedgerBefore(ch, lo),
  ]);
  let excluded: ExcludedLines | undefined;
  let excludedChanges: SeriesChange[] = [];
  if (o.exclude !== undefined) {
    const at = startLedger === undefined ? undefined : Math.min(startLedger, o.toLedger);
    [excluded, excludedChanges] = await Promise.all([
      excludedAt(ch, g, token, at, o.exclude),
      ch.query<SeriesChange>(
        `SELECT ${SERIES_CHANGE_COLUMNS} FROM ${Table.TokenHolderChanges}
          WHERE ${prefixOf} AND ledger_index > {start:UInt32} AND ledger_index <= {toLedger:UInt32}
            AND close_time < toDateTime({hi:UInt32}, 'UTC') AND holder IN {holders:Array(String)}
          ORDER BY ledger_index, tx_index, node_index, holder
          LIMIT 1 BY ledger_index, tx_index, node_index, holder`,
        { ...params, start: at ?? 0, holders: o.exclude },
      ),
    ]);
  }
  let levels = {
    supply: new BigNumber(carryRow?.supply ?? 0),
    holders: Number(carryRow?.holders ?? 0),
    trust_lines: Number(carryRow?.trust_lines ?? 0),
    ledger: Number(carryRow?.last_ledger ?? 0),
  };
  const out: SupplyPoint[] = [];
  let h = 0;
  let x = 0;
  for (const b of buckets) {
    const end = b + size;
    let issued = new BigNumber(0);
    let redeemed = new BigNumber(0);
    let clawed = new BigNumber(0);
    let unknown = 0;
    while (h < hours.length && Number(hours[h].hour) < end) {
      const r = hours[h++];
      issued = issued.plus(r.issued);
      redeemed = redeemed.plus(r.redeemed);
      clawed = clawed.plus(r.clawed_back);
      unknown += Number(r.unknown_before);
      levels = {
        supply: new BigNumber(r.supply),
        holders: Number(r.holders),
        trust_lines: Number(r.trust_lines),
        ledger: Number(r.last_ledger),
      };
    }
    while (excluded !== undefined && x < excludedChanges.length && Number(excludedChanges[x].close_time) < end) {
      const c = excludedChanges[x++];
      excluded.apply(c.holder, c.amount_after, Number(c.counted_after) === 1);
    }
    out.push({
      time: b,
      ledger_index: levels.ledger,
      supply: text(levels.supply),
      holders: levels.holders,
      trust_lines: levels.trust_lines,
      issued: text(issued),
      redeemed: text(redeemed),
      clawed_back: text(clawed),
      net: text(issued.minus(redeemed).minus(clawed)),
      unknown_before: unknown,
      ...(excluded !== undefined && { without_excluded: excluded.without(levels) }),
    });
  }
  return out;
}

async function ledgerSeries(
  ch: ClickHouseService,
  g: number,
  token: TokenKey,
  o: Parameters<typeof supplySeries>[3],
): Promise<SupplyPoint[]> {
  const to = Math.min(o.to, o.toLedger);
  const bound =
    o.after === undefined
      ? ''
      : o.descending
        ? 'AND ledger_index < {after:UInt32}'
        : 'AND ledger_index > {after:UInt32}';
  const params = {
    g,
    issuer: token.issuer,
    currency: token.currency,
    from: o.from,
    to,
    after: o.after ?? 0,
    limit: o.limit + 1,
  };
  const page = (
    await ch.query<{ ledger_index: number | string }>(
      `SELECT ledger_index FROM ${Table.TokenHolderChanges}
        WHERE ${prefixOf} AND ledger_index >= {from:UInt32} AND ledger_index <= {to:UInt32} ${bound}
        GROUP BY ledger_index
        ORDER BY ledger_index ${o.descending ? 'DESC' : 'ASC'}
        LIMIT {limit:UInt32}`,
      params,
    )
  )
    .map((r) => Number(r.ledger_index))
    .sort((a, b) => a - b);
  if (page.length === 0) return [];
  const lo = page[0];
  const hi = page[page.length - 1];
  const [before, changes, excluded] = await Promise.all([
    totalsAt(ch, g, token, lo - 1),
    ch.query<SeriesChange>(
      `SELECT ${SERIES_CHANGE_COLUMNS} FROM ${Table.TokenHolderChanges}
        WHERE ${prefixOf} AND ledger_index >= {lo:UInt32} AND ledger_index <= {hi:UInt32}
        ORDER BY ledger_index, tx_index, node_index, holder
        LIMIT 1 BY ledger_index, tx_index, node_index, holder`,
      { ...params, lo, hi },
    ),
    o.exclude === undefined ? Promise.resolve(undefined) : excludedAt(ch, g, token, lo - 1, o.exclude),
  ]);
  const excludedSet = new Set(o.exclude ?? []);
  let supply = new BigNumber(before.supply);
  let holders = before.holders;
  let lines = before.trust_lines;
  const out: SupplyPoint[] = [];
  let i = 0;
  for (const ledger of page) {
    let flows = new FlowsSum();
    let time = 0;
    while (i < changes.length && Number(changes[i].ledger_index) === ledger) {
      // one transaction's changes
      const tx = Number(changes[i].tx_index);
      const own: ChangeAmounts[] = [];
      let clawback = false;
      while (i < changes.length && Number(changes[i].ledger_index) === ledger && Number(changes[i].tx_index) === tx) {
        const c = changes[i++];
        time = Number(c.close_time);
        clawback ||= Number(c.clawback) === 1;
        own.push({ before: c.amount_before, after: c.amount_after, beforeKnown: Number(c.before_known) === 1 });
        supply = supply.plus(c.amount_after).minus(c.amount_before);
        holders += Number(c.amount_after !== '0') - Number(c.amount_before !== '0');
        lines += Number(c.counted_after) - Number(c.counted_before);
        if (excluded !== undefined && excludedSet.has(c.holder)) {
          excluded.apply(c.holder, c.amount_after, Number(c.counted_after) === 1);
        }
      }
      const f = flowsOfTransaction(own, clawback);
      flows.add(f);
      flows.unknown_before += f.unknown_before;
    }
    const served = flows.served();
    flows = new FlowsSum();
    out.push({
      time,
      ledger_index: ledger,
      supply: text(supply),
      holders,
      trust_lines: lines,
      issued: served.issued,
      redeemed: served.redeemed,
      clawed_back: served.clawed_back,
      net: text(new BigNumber(served.issued).minus(served.redeemed).minus(served.clawed_back)),
      unknown_before: served.unknown_before,
      ...(excluded !== undefined && { without_excluded: excluded.without({ supply, holders, trust_lines: lines }) }),
    });
  }
  return out;
}

// -- the distribution and the snapshot ---------------------------------------------------------------------------------------

/** A decade of the balances: `[10^decade, 10^(decade+1))`, its holders and their balance. */
export interface DecadeBucket {
  decade: number;
  min: string;
  max: string;
  holders: number;
  balance: string;
}

/** A token's distribution at a ledger (spec 5.4), with or without some holders. */
export interface Distribution {
  supply: string;
  holders: number;
  trust_lines: number;
  buckets: DecadeBucket[];
  /** The sums of the 10 and the 100 largest balances. */
  top10: string;
  top100: string;
}

const powerOfTen = (d: number): string => new BigNumber(10).pow(d).toFixed();

/**
 * The distribution of a token at `n` (spec 5.4), over the fold (`holdersAtSql`): one bucket per power of ten from the smallest
 * holder's to the largest's, the empty ones between included, by the order key (an issued amount's decade is `exp + 15`, its
 * mantissa being in [1e15, 1e16); an MPT's is its number of digits less one), and the sums of the largest 10 and 100 balances.
 * `exclude` leaves those holders out. The sums are exact: in the decimal, or in BigNumber over the fold when an amount does not fit.
 */
export async function distributionAt(
  ch: ClickHouseService,
  g: number,
  token: TokenKey & { kind: 'issued' | 'mpt' },
  n: number,
  exclude?: string[],
): Promise<Distribution> {
  const cp = await checkpointAt(ch, g, token, n);
  const params = {
    g,
    issuer: token.issuer,
    currency: token.currency,
    cp,
    n,
    mpt: token.kind === 'mpt' ? 1 : 0,
    exclude: exclude ?? [],
  };
  const fold = `(${holdersAtSql()})`;
  const without = exclude === undefined ? '' : ' AND holder NOT IN {exclude:Array(String)}';
  const decade = `toInt32(if({mpt:UInt8} = 1, length(toString(mant)) - 1, exp + 15))`;
  const [decades, lines, top] = await Promise.all([
    ch.query<{ decade: number | string; holders: number | string; b_exact: string | null; b_unfit: number | string }>(
      `SELECT ${decade} AS decade, toUInt64(count()) AS holders, ${exactSumColumns('amount', 'b')}
         FROM ${fold} WHERE amount != '0'${without}
        GROUP BY decade ORDER BY decade`,
      params,
    ),
    ch.queryOne<{ n: number | string }>(`SELECT toUInt64(count()) AS n FROM ${fold} WHERE TRUE${without}`, params),
    ch.query<{ amount: string }>(
      `SELECT amount FROM ${fold} WHERE amount != '0'${without} ORDER BY exp DESC, mant DESC, holder LIMIT 100`,
      params,
    ),
  ]);
  let sums = new Map(decades.map((d) => [Number(d.decade), new BigNumber(d.b_exact ?? 0)]));
  if (decades.some((d) => Number(d.b_unfit) > 0)) {
    sums = new Map();
    for (const r of await ch.query<{ decade: number | string; amount: string }>(
      `SELECT ${decade} AS decade, amount FROM ${fold} WHERE amount != '0'${without}`,
      params,
    )) {
      const d = Number(r.decade);
      sums.set(d, (sums.get(d) ?? new BigNumber(0)).plus(r.amount));
    }
  }
  const counts = new Map(decades.map((d) => [Number(d.decade), Number(d.holders)]));
  const buckets: DecadeBucket[] = [];
  if (decades.length > 0) {
    const lo = Number(decades[0].decade);
    const hi = Number(decades[decades.length - 1].decade);
    for (let d = lo; d <= hi; d++) {
      buckets.push({
        decade: d,
        min: powerOfTen(d),
        max: powerOfTen(d + 1),
        holders: counts.get(d) ?? 0,
        balance: text(sums.get(d) ?? new BigNumber(0)),
      });
    }
  }
  const sumOf = (rows: { amount: string }[]) => text(rows.reduce((s, r) => s.plus(r.amount), new BigNumber(0)));
  return {
    supply: text([...sums.values()].reduce((s, b) => s.plus(b), new BigNumber(0))),
    holders: [...counts.values()].reduce((s, c) => s + c, 0),
    trust_lines: Number(lines?.n ?? 0),
    buckets,
    top10: sumOf(top.slice(0, 10)),
    top100: sumOf(top),
  };
}

/** A holder of a snapshot (spec 5.7): `balance` is the served text, an MPT's `amount + escrowed`. */
export interface SnapshotHolder {
  holder: string;
  balance: string;
  escrowed: string;
  limit: string;
  frozen: boolean;
  authorized: boolean;
}

/**
 * A page of a token's holders at `n` (amount above 0), by `holder` (the byte order of the address), after `after`, `limit + 1` rows at
 * most so that the caller can tell there is more. Each page folds the token at `n` (`holdersAtSql`).
 */
export async function snapshotPage(
  ch: ClickHouseService,
  g: number,
  token: TokenKey,
  n: number,
  after: string | undefined,
  limit: number,
): Promise<SnapshotHolder[]> {
  const cp = await checkpointAt(ch, g, token, n);
  const rows = await ch.query<{
    holder: string;
    amount: string;
    limit: string;
    frozen: number;
    authorized: number;
    escrowed: string;
  }>(
    `SELECT holder, amount, \`limit\`, frozen, authorized, escrowed FROM (${holdersAtSql()})
      WHERE amount != '0' AND holder > {after:String}
      ORDER BY holder
      LIMIT {limit:UInt32}`,
    { g, issuer: token.issuer, currency: token.currency, cp, n, after: after ?? '', limit: limit + 1 },
  );
  return rows.map((r) => ({
    holder: r.holder,
    balance: r.amount,
    escrowed: r.escrowed,
    limit: r.limit,
    frozen: Number(r.frozen) === 1,
    authorized: Number(r.authorized) === 1,
  }));
}

/**
 * The `digest` of a token's snapshot at `n` (spec 5.7), in ClickHouse: SHA-256 of `<holder>,<balance>\n` for every holder, by
 * `holder`, as `snapshotDigest` computes it from the same lines.
 */
export async function snapshotDigestAt(ch: ClickHouseService, g: number, token: TokenKey, n: number): Promise<string> {
  const cp = await checkpointAt(ch, g, token, n);
  const row = await ch.queryOne<{ digest: string }>(
    `SELECT lower(hex(SHA256(arrayStringConcat(
              arrayMap(x -> concat(x.1, ',', x.2, '\\n'), arraySort(groupArray(tuple(holder, amount)))), '')))) AS digest
       FROM (${holdersAtSql()}) WHERE amount != '0'`,
    { g, issuer: token.issuer, currency: token.currency, cp, n },
  );
  return row?.digest ?? snapshotDigest([]);
}
