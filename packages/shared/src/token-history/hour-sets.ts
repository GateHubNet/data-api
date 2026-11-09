import BigNumber from 'bignumber.js';
import type { TokenKey } from '../aggregate/token-rules';
import { ClickHouseService } from '../clickhouse/clickhouse.service';
import { TokenHourlyRow } from '../clickhouse/rows';
import { Table } from '../clickhouse/tables';
import { ChangeAmounts, flowsOfTransaction } from './flows';

/**
 * Hour sets (spec 4.4): the `token_hourly` row of a token and hour, recomputed whole from the change log. The flows are grouped by
 * transaction first, then summed; the levels are the previous hour row's plus the hour's net change. This is the exact path, in
 * BigNumber: the live windows use it for the few hours they touch, and the build for a slice whose amounts the decimal cannot hold.
 */

const HOUR = 3_600;

/** The levels of a token at the end of an hour. */
export interface HourLevels {
  supply: string;
  holders: number;
  trust_lines: number;
}

const ZERO_LEVELS: HourLevels = { supply: '0', holders: 0, trust_lines: 0 };

/** The newest row of the newest hour of a token before `hour` (unix seconds) in generation `g`: the levels the hour starts from. */
export async function levelsBefore(ch: ClickHouseService, g: number, token: TokenKey, hour: number): Promise<HourLevels> {
  const row = await ch.queryOne<{ supply: string; holders: string; trust_lines: string }>(
    `SELECT supply, toString(holders) AS holders, toString(trust_lines) AS trust_lines
       FROM ${Table.TokenHourly}
      WHERE generation = {g:UInt32} AND issuer = {issuer:String} AND currency = {currency:String}
        AND hour < toDateTime({hour:UInt32}, 'UTC')
      ORDER BY hour DESC, version DESC
      LIMIT 1`,
    { g, issuer: token.issuer, currency: token.currency, hour },
  );
  return row === undefined
    ? ZERO_LEVELS
    : { supply: row.supply, holders: Number(row.holders), trust_lines: Number(row.trust_lines) };
}

/** The first and last ledger that close in an hour (unix seconds), from `ledgers` (a minmax index on `close_time`); none when no ledger does. */
export async function ledgersOfHour(
  ch: ClickHouseService,
  hour: number,
): Promise<{ first: number; last: number } | undefined> {
  const row = await ch.queryOne<{ first: number | null; last: number | null; n: string }>(
    `SELECT min(ledger_index) AS first, max(ledger_index) AS last, toString(count()) AS n FROM ${Table.Ledgers}
      WHERE close_time >= toDateTime({hour:UInt32}, 'UTC') AND close_time < toDateTime({end:UInt32}, 'UTC')`,
    { hour, end: hour + HOUR },
  );
  return row === undefined || row.n === '0' ? undefined : { first: Number(row.first), last: Number(row.last) };
}

/** The start of the hour of a ledger's close time (unix seconds), from `ledgers`; `undefined` when the ledger is not stored. */
export async function closeHourOf(ch: ClickHouseService, ledger: number): Promise<number | undefined> {
  const row = await ch.queryOne<{ hour: number }>(
    `SELECT toUnixTimestamp(toStartOfHour(close_time)) AS hour FROM ${Table.Ledgers} WHERE ledger_index = {ledger:UInt32} LIMIT 1`,
    { ledger },
  );
  return row === undefined ? undefined : Number(row.hour);
}

interface ChangeRead {
  ledger_index: number;
  tx_index: number;
  clawback: number;
  amount_before: string;
  amount_after: string;
  counted_before: number;
  counted_after: number;
  before_known: number;
}

/**
 * The row of one hour, from its changes in key order and the levels it starts from. Pure; `final` and `version` are the caller's.
 */
export function hourRowOf(
  changes: readonly ChangeRead[],
  base: HourLevels,
): Omit<TokenHourlyRow, 'generation' | 'issuer' | 'currency' | 'hour' | 'final' | 'version'> {
  const txs = new Map<string, { changes: ChangeAmounts[]; clawback: boolean }>();
  let net = new BigNumber(0);
  let holders = base.holders;
  let lines = base.trust_lines;
  let unknown = 0;
  for (const c of changes) {
    const key = `${c.ledger_index}:${c.tx_index}`;
    const tx = txs.get(key) ?? { changes: [], clawback: c.clawback === 1 };
    tx.changes.push({ before: c.amount_before, after: c.amount_after, beforeKnown: c.before_known === 1 });
    txs.set(key, tx);
    net = net.plus(c.amount_after).minus(c.amount_before);
    holders += (c.amount_after !== '0' ? 1 : 0) - (c.amount_before !== '0' ? 1 : 0);
    lines += c.counted_after - c.counted_before;
    if (c.before_known === 0) unknown++;
  }
  const sums = { issued: new BigNumber(0), redeemed: new BigNumber(0), clawed_back: new BigNumber(0), transferred: new BigNumber(0) };
  let transfers = 0;
  for (const tx of txs.values()) {
    const f = flowsOfTransaction(tx.changes, tx.clawback);
    sums.issued = sums.issued.plus(f.issued);
    sums.redeemed = sums.redeemed.plus(f.redeemed);
    sums.clawed_back = sums.clawed_back.plus(f.clawed_back);
    sums.transferred = sums.transferred.plus(f.transferred);
    transfers += f.transfers;
  }
  const text = (n: BigNumber): string => (n.isZero() ? '0' : n.toFixed());
  return {
    supply: text(new BigNumber(base.supply).plus(net)),
    holders: String(holders),
    trust_lines: String(lines),
    issued: text(sums.issued),
    redeemed: text(sums.redeemed),
    clawed_back: text(sums.clawed_back),
    transferred: text(sums.transferred),
    transfers,
    changes: changes.length,
    unknown_before: unknown,
    first_ledger: changes.length === 0 ? 0 : changes[0].ledger_index,
    last_ledger: changes.length === 0 ? 0 : changes[changes.length - 1].ledger_index,
  };
}

/** The writer's clock in milliseconds, above the newest version of the key. */
async function versionAbove(ch: ClickHouseService, g: number, token: TokenKey, hour: number): Promise<string> {
  const row = await ch.queryOne<{ newest: string }>(
    `SELECT toString(max(version)) AS newest FROM ${Table.TokenHourly}
      WHERE generation = {g:UInt32} AND issuer = {issuer:String} AND currency = {currency:String}
        AND hour = toDateTime({hour:UInt32}, 'UTC')`,
    { g, issuer: token.issuer, currency: token.currency, hour },
  );
  const newest = BigInt(row?.newest ?? '0');
  const now = BigInt(Date.now());
  return (now > newest ? now : newest + 1n).toString();
}

/**
 * Writes whole `token_hourly` rows of a token for the given hours (in any order), from its changes up to `through` (spec 4.4), each
 * from the levels of the newest earlier hour row: an hour of the list is written before a later one reads it. An hour with no change
 * up to `through` gets no row. `final` is 1 for an hour before the hour `through` closes in. The version is `opts.version`, or the
 * clock in milliseconds above the key's newest.
 */
export async function writeHourSets(
  ch: ClickHouseService,
  g: number,
  token: TokenKey,
  hours: Date[],
  through: number,
  opts: { version?: number | string } = {},
): Promise<void> {
  const throughHour = await closeHourOf(ch, through);
  const sorted = [...new Set(hours.map((h) => Math.floor(h.getTime() / 1000 / HOUR) * HOUR))].sort((a, b) => a - b);
  for (const hour of sorted) {
    const range = await ledgersOfHour(ch, hour);
    if (range === undefined || range.first > through) continue;
    const changes = await ch.query<ChangeRead>(
      `SELECT ledger_index, tx_index, clawback, amount_before, amount_after, counted_before, counted_after, before_known
         FROM ${Table.TokenHolderChanges}
        WHERE generation = {g:UInt32} AND issuer = {issuer:String} AND currency = {currency:String}
          AND ledger_index >= {first:UInt32} AND ledger_index <= {last:UInt32}
        ORDER BY ledger_index, tx_index, node_index, holder
        LIMIT 1 BY ledger_index, tx_index, node_index, holder`,
      { g, issuer: token.issuer, currency: token.currency, first: range.first, last: Math.min(range.last, through) },
    );
    if (changes.length === 0) continue;
    const row: TokenHourlyRow = {
      generation: g,
      issuer: token.issuer,
      currency: token.currency,
      hour,
      ...hourRowOf(changes, await levelsBefore(ch, g, token, hour)),
      final: throughHour !== undefined && hour < throughHour ? 1 : 0,
      version: opts.version ?? (await versionAbove(ch, g, token, hour)),
    };
    await ch.insert(Table.TokenHourly, [row]);
  }
}
