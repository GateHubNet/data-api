import BigNumber from 'bignumber.js';
import type { TokenKey } from '../aggregate/token-rules';
import { ClickHouseService } from '../clickhouse/clickhouse.service';
import { Table } from '../clickhouse/tables';
import { isMptIssuanceId } from '../util/mpt';
import { ChangeAmounts, flowsOfTransaction } from './flows';
import { totalsAt } from './holders-at';
import { closeHourOf } from './hour-sets';

/**
 * The reads of the token history's routes (spec 3, 5) that are not the fold: the tokens of an issuer, the flows and the DEX figures
 * of a window. Each starts from a token's (or an issuer's) key prefix and is bounded (spec 7); the sums are exact, in BigNumber.
 */

const HOUR = 3_600;
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
  clawback: number;
  amount_before: string;
  amount_after: string;
  before_known: number;
}

/**
 * The flows of a token's changes in `[fromLedger, toLedger]` (spec 3.5): the `token_hourly` rows of the hours wholly inside it, plus
 * the change log of its two edge hours, grouped by transaction (`flowsOfTransaction`). So the read is bounded by the window's hours
 * and two hours of the token's changes, wherever the window lies. A transaction is in one ledger, so in one hour.
 */
export async function windowFlows(
  ch: ClickHouseService,
  g: number,
  token: TokenKey,
  fromLedger: number,
  toLedger: number,
): Promise<WindowFlows> {
  const sum = new FlowsSum();
  if (fromLedger > toLedger) return sum.served();
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
      `SELECT ledger_index, tx_index, clawback, amount_before, amount_after, before_known
         FROM ${Table.TokenHolderChanges}
        WHERE ${prefix} AND ledger_index >= {fromLedger:UInt32} AND ledger_index <= {toLedger:UInt32} AND ${edgeCondition}
        ORDER BY ledger_index, tx_index, node_index, holder
        LIMIT 1 BY ledger_index, tx_index, node_index, holder`,
      params,
    ),
    fromHour === toHour || toHour - fromHour === HOUR
      ? Promise.resolve([])
      : ch.query<{
          issued: string;
          redeemed: string;
          clawed_back: string;
          transferred: string;
          transfers: number | string;
          changes: number | string;
          unknown_before: number | string;
        }>(
          `SELECT issued, redeemed, clawed_back, transferred, transfers, changes, unknown_before
             FROM ${Table.TokenHourly}
            WHERE ${prefix} AND hour > toDateTime({fromHour:UInt32}, 'UTC') AND hour < toDateTime({toHour:UInt32}, 'UTC')
            ORDER BY hour, version DESC
            LIMIT 1 BY hour`,
          params,
        ),
  ]);
  for (const h of hours) {
    sum.add({ ...h, transfers: Number(h.transfers) });
    sum.changes += Number(h.changes);
    sum.unknown_before += Number(h.unknown_before);
  }
  let tx: { key: string; clawback: boolean; changes: ChangeAmounts[] } | undefined;
  const flush = (): void => {
    if (tx === undefined) return;
    const f = flowsOfTransaction(tx.changes, tx.clawback);
    sum.add(f);
    sum.changes += tx.changes.length;
    sum.unknown_before += f.unknown_before;
  };
  for (const c of edges) {
    const key = `${c.ledger_index}:${c.tx_index}`;
    if (tx?.key !== key) {
      flush();
      tx = { key, clawback: false, changes: [] };
    }
    tx.clawback ||= Number(c.clawback) === 1;
    tx.changes.push({ before: c.amount_before, after: c.amount_after, beforeKnown: Number(c.before_known) === 1 });
  }
  flush();
  return sum.served();
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

/**
 * The DEX figures of a token over the hours `[fromHour, toHour)` (unix seconds, whole hours), from `token_hourly_dex`: the hours with a
 * sentinel only, a token row counting when it is of its hour's sentinel write or a newer one (a row older than the sentinel is of a
 * write the newer one replaced). `undefined` when no hour of the window has a sentinel.
 */
export async function dexOfWindow(
  ch: ClickHouseService,
  token: TokenKey,
  fromHour: number,
  toHour: number,
): Promise<WindowDex | undefined> {
  if (fromHour >= toHour) return undefined;
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
  if (sentinels.length === 0) return undefined;
  const sentinelVersion = new Map(sentinels.map((s) => [Number(s.hour), BigInt(s.version)]));
  let exchanged = new BigNumber(0);
  let trades = 0;
  for (const r of rows) {
    const v = sentinelVersion.get(Number(r.hour));
    if (v === undefined || BigInt(r.version) < v) continue;
    exchanged = exchanged.plus(r.exchanged);
    trades += Number(r.trades);
  }
  const newest = Math.max(...sentinels.map((s) => Number(s.hour)));
  return {
    exchanged: text(exchanged),
    trades,
    through: new Date((newest + HOUR) * 1000),
    complete: sentinels.length === (toHour - fromHour) / HOUR,
  };
}
