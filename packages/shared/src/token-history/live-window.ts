import type { TokenKey } from '../aggregate/token-rules';
import { LineKey, parserFloorOf, touchesOfWindow } from '../aggregate/tokens.job';
import { ClickHouseService } from '../clickhouse/clickhouse.service';
import { MPT_PARSER_VERSION, TOKEN_PARSER_VERSION, TokenHistoryStateRow, TokenHolderChangesRow } from '../clickhouse/rows';
import { Table } from '../clickhouse/tables';
import { mptIssuerOf } from '../util/mpt';
import { CLAWBACK_TX_TYPES } from './build/changes-pass';
import { writeCheckpoint } from './build/levels';
import { issuedComplete, mptComplete } from './build/run-build';
import { checkpointAt, totalsAt } from './holders-at';
import { checkpointLedgers, LedgerTotals } from './checkpoint-rule';
import { TOKEN_HISTORY_CHECKPOINT_FLOOR } from './constants';
import { writeHourSets } from './hour-sets';
import { orderKeyOf } from './order-key';
import { patchTokenHistoryState } from './state';
import { issuedSideOf, mptSideOf, TokenSide } from './token-side';

/**
 * The live window (spec 4.2): the worker's step at the head. It reads what changed in `(through_ledger, to]` from the touch indexes
 * and the per-line prefixes of the state tables, then writes, in this order, the change rows (to the live and the building
 * generation), the hour sets and the checkpoints (in a generation whose levels are caught up), and each generation's state row last.
 * A crash before the state row leaves rows no reader reaches (they read up to `levels_through`), and the window is applied again
 * with the same keys.
 */

/** A window that holds a ledger of a parser older than the touch indexes': it is never applied live (spec 4.2 step 4). */
export class OlderParserWindow extends Error {
  constructor(
    readonly from: number,
    readonly to: number,
    readonly floor: number,
  ) {
    super(`the window (${from}, ${to}] holds a ledger of parser version ${floor}, older than the token history reads`);
    this.name = 'OlderParserWindow';
  }
}

/** The steps of a window, for `afterStep`. */
export type LiveWindowStep = 'changes' | 'hours' | 'checkpoints';

export interface LiveWindowOptions extends WindowLevelsOptions {
  hasMpt: boolean;
  /** The network, for whether a generation's coverage is complete (spec 6). */
  network: string;
  /** `touchesOfWindow`'s window and line cap (default D6's: 500 ledgers, halved above 20,000 lines). */
  window?: number;
  maxLines?: number;
}

/** The options of the levels of a window. */
export interface WindowLevelsOptions {
  /** The checkpoint floor (default `TOKEN_HISTORY_CHECKPOINT_FLOOR`; the tests lower it). */
  floor?: number;
  /** Called after each step of the writes (the tests stop a window there). */
  afterStep?: (step: LiveWindowStep) => void | Promise<void>;
  /** Told when a sum falls back to BigNumber. */
  onUnfit?: () => void;
}

/** Keys of three or two columns, as zipped arrays: `(a, b, c) IN` the zip, a prefix of the key of each table read. */
export function keysIn(columns: readonly string[], arrays: readonly string[]): string {
  const parameters = arrays.map((name) => `{${name}:Array(String)}`).join(', ');
  const elements = columns.map((_, i) => `tupleElement(key, ${i + 1})`).join(', ');
  return `(${columns.join(', ')}) IN (SELECT ${elements} FROM (SELECT arrayJoin(arrayZip(${parameters})) AS key))`;
}

const LINE_KEYS = keysIn(['account', 'counterparty', 'currency'], ['accounts', 'counterparties', 'currencies']);
const MPT_KEYS = keysIn(['holder', 'mpt_issuance_id'], ['holders', 'ids']);

/** A state row of one side of a line, or of an `MPToken`, as the window reads it. */
interface StateRead {
  key: string;
  ledger_index: number;
  tx_index: number;
  node_index: number;
  close_time: number;
  side: TokenSide;
}

const ISSUED_COLUMNS = `account, counterparty, currency, ledger_index, tx_index, node_index, toUnixTimestamp(close_time) AS close_time,
       balance, limit_peer, freeze, authorized, deleted`;
const MPT_COLUMNS = `holder, mpt_issuance_id, ledger_index, tx_index, node_index, toUnixTimestamp(close_time) AS close_time, tx_type,
       toString(amount) AS amount, toString(escrowed_amount) AS escrowed_amount, flags, deleted`;

interface IssuedRow {
  account: string;
  counterparty: string;
  currency: string;
  ledger_index: number;
  tx_index: number;
  node_index: number;
  close_time: number;
  balance: string;
  limit_peer: string;
  freeze: number;
  authorized: number;
  deleted: number;
}

interface MptRow {
  holder: string;
  mpt_issuance_id: string;
  ledger_index: number;
  tx_index: number;
  node_index: number;
  close_time: number;
  tx_type: string;
  amount: string;
  escrowed_amount: string;
  flags: number;
  deleted: number;
}

/** The rows of a window and the newest row before it, of each key, with the kind of the token. */
interface KeyHistory {
  kind: 'issued' | 'mpt';
  before?: StateRead;
  rows: StateRead[];
  /** The keys of the clawback transactions (`ledger:tx`) of an issued key; an MPT row carries its own. */
  clawbacks?: Set<string>;
  mptClawbacks?: Set<string>;
}

/** Reads the window's state rows of the lines `lines` (both sides of each) and of the MPT pairs, and the newest rows before it. */
async function windowHistories(
  ch: ClickHouseService,
  lines: LineKey[],
  mpts: Array<{ holder: string; id: string }>,
  from: number,
  to: number,
): Promise<Map<string, KeyHistory>> {
  const out = new Map<string, KeyHistory>();
  if (lines.length > 0) {
    const sides = lines.flatMap((l) => [
      [l.account, l.counterparty, l.currency],
      [l.counterparty, l.account, l.currency],
    ]);
    const params = {
      accounts: sides.map((s) => s[0]),
      counterparties: sides.map((s) => s[1]),
      currencies: sides.map((s) => s[2]),
      from,
      to,
    };
    const [rows, before, claws] = await Promise.all([
      ch.query<IssuedRow>(
        `SELECT ${ISSUED_COLUMNS} FROM ${Table.TrustLineStates}
          WHERE ${LINE_KEYS} AND ledger_index > {from:UInt32} AND ledger_index <= {to:UInt32}
          ORDER BY account, counterparty, currency, ledger_index, tx_index, node_index
          LIMIT 1 BY account, counterparty, currency, ledger_index, tx_index, node_index`,
        params,
      ),
      ch.query<IssuedRow>(
        `SELECT ${ISSUED_COLUMNS} FROM ${Table.TrustLineStates}
          WHERE ${LINE_KEYS} AND ledger_index <= {from:UInt32}
          ORDER BY account, counterparty, currency, ledger_index DESC, tx_index DESC, node_index DESC
          LIMIT 1 BY account, counterparty, currency`,
        params,
      ),
      ch.query<{ ledger_index: number; tx_index: number }>(
        `SELECT ledger_index, tx_index FROM ${Table.TxByType}
          WHERE tx_type IN {types:Array(String)} AND ledger_index > {from:UInt32} AND ledger_index <= {to:UInt32}`,
        { types: [...CLAWBACK_TX_TYPES], from, to },
      ),
    ]);
    const clawbacks = new Set(claws.map((c) => `${c.ledger_index}:${c.tx_index}`));
    const read = (r: IssuedRow): StateRead | undefined => {
      const side = issuedSideOf(r);
      return side === null
        ? undefined
        : { key: `i|${r.account}|${r.counterparty}|${r.currency}`, ...r, side };
    };
    for (const r of before) {
      const s = read(r);
      if (s) out.set(s.key, { kind: 'issued', before: s, rows: [], clawbacks });
    }
    for (const r of rows) {
      const s = read(r);
      if (!s) continue;
      const h = out.get(s.key) ?? { kind: 'issued' as const, rows: [], clawbacks };
      h.rows.push(s);
      out.set(s.key, h);
    }
  }
  if (mpts.length > 0) {
    const params = { holders: mpts.map((m) => m.holder), ids: mpts.map((m) => m.id), from, to };
    const [rows, before] = await Promise.all([
      ch.query<MptRow>(
        `SELECT ${MPT_COLUMNS} FROM ${Table.MptHolderStates}
          WHERE ${MPT_KEYS} AND ledger_index > {from:UInt32} AND ledger_index <= {to:UInt32}
          ORDER BY holder, mpt_issuance_id, ledger_index, tx_index, node_index
          LIMIT 1 BY holder, mpt_issuance_id, ledger_index, tx_index, node_index`,
        params,
      ),
      ch.query<MptRow>(
        `SELECT ${MPT_COLUMNS} FROM ${Table.MptHolderStates}
          WHERE ${MPT_KEYS} AND ledger_index <= {from:UInt32}
          ORDER BY holder, mpt_issuance_id, ledger_index DESC, tx_index DESC, node_index DESC
          LIMIT 1 BY holder, mpt_issuance_id`,
        params,
      ),
    ]);
    const mptClawbacks = new Set(
      rows.filter((r) => (CLAWBACK_TX_TYPES as readonly string[]).includes(r.tx_type)).map((r) => `${r.ledger_index}:${r.tx_index}`),
    );
    const read = (r: MptRow): StateRead => ({
      key: `m|${r.holder}|${r.mpt_issuance_id}`,
      ...r,
      side: mptSideOf(r, mptIssuerOf(r.mpt_issuance_id)),
    });
    for (const r of before) out.set(read(r).key, { kind: 'mpt', before: read(r), rows: [], mptClawbacks });
    for (const r of rows) {
      const s = read(r);
      const h = out.get(s.key) ?? { kind: 'mpt' as const, rows: [], mptClawbacks };
      h.rows.push(s);
      out.set(s.key, h);
    }
  }
  return out;
}

const NOT_COUNTED = { counted: false, amount: '0' } as const;

/**
 * The change rows of one generation from the window's histories: each key's rows in order, the before-state of the first the newest
 * row before the window, unless that one is below the generation's coverage (then the before-state is unknown) or there is none (then
 * the line is made in the window: known when the coverage is complete), as the build's changes pass rules. Only rows above the
 * generation's `through_ledger` are written (the build's pass, or an earlier window, wrote the others); every row of the window serves
 * as a before-state. Only changes where the line counted before or after.
 */
function changesOf(
  gen: TokenHistoryStateRow,
  histories: Map<string, KeyHistory>,
  complete: { issued: boolean; mpt: boolean },
): TokenHolderChangesRow[] {
  const out: TokenHolderChangesRow[] = [];
  for (const h of histories.values()) {
    let prev: Pick<TokenSide, 'counted' | 'amount'> = NOT_COUNTED;
    let known = complete[h.kind];
    if (h.before !== undefined) {
      if (h.before.ledger_index >= gen.coverage_from) {
        prev = h.before.side;
        known = true;
      } else {
        known = false;
      }
    }
    for (const r of h.rows) {
      if (r.ledger_index > gen.through_ledger && (prev.counted || r.side.counted)) {
        const key = orderKeyOf(r.side.amount, h.kind);
        const txKey = `${r.ledger_index}:${r.tx_index}`;
        out.push({
          generation: gen.generation,
          issuer: r.side.issuer,
          currency: r.side.currency,
          ledger_index: r.ledger_index,
          tx_index: r.tx_index,
          node_index: r.node_index,
          holder: r.side.holder,
          close_time: r.close_time,
          clawback: (h.kind === 'issued' ? h.clawbacks : h.mptClawbacks)?.has(txKey) ? 1 : 0,
          amount_before: prev.amount,
          amount_after: r.side.amount,
          counted_before: prev.counted ? 1 : 0,
          counted_after: r.side.counted ? 1 : 0,
          before_known: known ? 1 : 0,
          limit: r.side.limit,
          frozen: r.side.frozen ? 1 : 0,
          authorized: r.side.authorized ? 1 : 0,
          escrowed: r.side.escrowed,
          order_exp: key.exp,
          order_mant: key.mant.toString(),
        });
      }
      prev = r.side;
      known = true;
    }
  }
  return out;
}

const tokenKey = (t: TokenKey): string => `${t.issuer}|${t.currency}`;

/** The hour (unix seconds) of a close time. */
const hourOf = (closeTime: number): number => Math.floor(closeTime / 3_600) * 3_600;

/**
 * The levels of a generation over its change rows of the ledgers `(gen.through_ledger, to]`: the hour sets of the touched (token,
 * hour) pairs, then the checkpoints the rule calls for at those ledgers (rows, then head). The live window runs it over its own change
 * rows; a finished build's catch-up over the rows of `(levels_through, to]`, with `through_ledger` read as `levels_through`.
 */
export async function windowLevels(
  ch: ClickHouseService,
  gen: TokenHistoryStateRow,
  changes: TokenHolderChangesRow[],
  to: number,
  o: WindowLevelsOptions,
): Promise<void> {
  const tokens = new Map<string, { token: TokenKey; hours: Set<number>; rows: TokenHolderChangesRow[] }>();
  for (const c of changes) {
    const k = tokenKey(c);
    const t = tokens.get(k) ?? { token: { issuer: c.issuer, currency: c.currency }, hours: new Set<number>(), rows: [] };
    t.hours.add(hourOf(c.close_time));
    t.rows.push(c);
    tokens.set(k, t);
  }
  for (const t of tokens.values()) {
    await writeHourSets(ch, gen.generation, t.token, [...t.hours].map((h) => new Date(h * 1000)), to);
  }
  await o.afterStep?.('hours');

  const floor = o.floor ?? TOKEN_HISTORY_CHECKPOINT_FLOOR;
  for (const t of tokens.values()) {
    const at = gen.through_ledger;
    let previousCp = await checkpointAt(ch, gen.generation, t.token, at);
    const [since, totals, first] = await Promise.all([
      ch.queryOne<{ n: string }>(
        `SELECT toString(count()) AS n FROM (SELECT 1 FROM ${Table.TokenHolderChanges}
          WHERE generation = {g:UInt32} AND issuer = {issuer:String} AND currency = {currency:String}
            AND ledger_index > {cp:UInt32} AND ledger_index <= {at:UInt32}
          GROUP BY ledger_index, tx_index, node_index, holder)`,
        { g: gen.generation, ...t.token, cp: previousCp, at },
      ),
      totalsAt(ch, gen.generation, t.token, at, { onUnfit: o.onUnfit }),
      ch.queryOne<{ ledger_index: number }>(
        `SELECT ledger_index FROM ${Table.TokenHolderChanges}
          WHERE generation = {g:UInt32} AND issuer = {issuer:String} AND currency = {currency:String}
          ORDER BY ledger_index LIMIT 1`,
        { g: gen.generation, ...t.token },
      ),
    ]);
    let lines = totals.trust_lines;
    const byLedger = new Map<number, { changes: number; lines: number }>();
    for (const c of t.rows) {
      const v = byLedger.get(c.ledger_index) ?? { changes: 0, lines: 0 };
      v.changes++;
      v.lines += c.counted_after - c.counted_before;
      byLedger.set(c.ledger_index, v);
    }
    const ledgers: LedgerTotals[] = [...byLedger.entries()]
      .sort(([a], [b]) => a - b)
      .map(([ledger_index, v]) => {
        lines += v.lines;
        return { ledger_index, changes: v.changes, trust_lines_after: lines };
      });
    let changesSince = Number(since?.n ?? 0);
    const cps = new Set(checkpointLedgers(ledgers, changesSince, floor));
    for (const l of ledgers) {
      changesSince += l.changes;
      if (!cps.has(l.ledger_index)) continue;
      await writeCheckpoint(ch, gen.generation, t.token, l.ledger_index, previousCp, changesSince, Number(first?.ledger_index ?? 0), {
        onUnfit: o.onUnfit,
      });
      previousCp = l.ledger_index;
      changesSince = 0;
    }
  }
  await o.afterStep?.('checkpoints');
}

/**
 * Applies the next live window to the generations `gens` (the live one and a building one; a retired one is left out), up to `head`
 * (spec 4.2). The window starts at the lowest `through_ledger` of them and is `touchesOfWindow`'s. It writes the change rows of each
 * generation above its own `through_ledger`, the hour sets and checkpoints in each generation whose `levels_through` has reached its
 * `through_ledger`, and each state row last (`through_ledger`, and `levels_through` where the levels ran). Refuses (`OlderParserWindow`)
 * a window holding a ledger of a parser below `TOKEN_PARSER_VERSION`, or below `MPT_PARSER_VERSION` on a network with MPTs. Returns
 * the window's end and the change rows it wrote.
 */
export async function applyLiveWindow(
  ch: ClickHouseService,
  gens: TokenHistoryStateRow[],
  head: number,
  o: LiveWindowOptions,
): Promise<{ to: number; changes: number }> {
  const active = gens.filter((g) => g.state !== 'retired');
  if (active.length === 0) return { to: head, changes: 0 };
  const from = Math.min(...active.map((g) => g.through_ledger));
  if (from >= head) return { to: from, changes: 0 };

  const window = await touchesOfWindow(ch, from, head, { window: o.window, maxLines: o.maxLines });
  const to = window.to;
  if (to <= from) return { to: from, changes: 0 };
  const floor = await parserFloorOf(ch, from, to);
  if (floor !== null && (floor < TOKEN_PARSER_VERSION || (o.hasMpt && floor < MPT_PARSER_VERSION))) {
    throw new OlderParserWindow(from, to, floor);
  }
  const mpts = o.hasMpt
    ? (
        await ch.query<{ holder: string; id: string }>(
          `SELECT DISTINCT holder, mpt_issuance_id AS id FROM ${Table.MptTouches}
            WHERE ledger_index > {from:UInt32} AND ledger_index <= {to:UInt32} AND holder != ''`,
          { from, to },
        )
      )
    : [];
  const histories = await windowHistories(ch, window.lines, mpts, from, to);

  let written = 0;
  const changesByGen = new Map<number, TokenHolderChangesRow[]>();
  for (const gen of active) {
    const changes = changesOf(gen, histories, {
      issued: issuedComplete(o.network, gen.coverage_from),
      mpt: mptComplete(o.network, gen.coverage_from),
    });
    changesByGen.set(gen.generation, changes);
    if (changes.length > 0) {
      await ch.insert(Table.TokenHolderChanges, changes, { dedupToken: `token_history:${gen.generation}:live:${from}-${to}` });
      written += changes.length;
    }
  }
  await o.afterStep?.('changes');

  // the live generation, and a building one whose build is done and whose levels the worker has caught up (spec 4.6)
  const levelled = active.filter(
    (g) => g.levels_through >= g.through_ledger && (g.state === 'live' || g.phase === 'done'),
  );
  for (const gen of levelled) await windowLevels(ch, gen, changesByGen.get(gen.generation) ?? [], to, o);

  for (const gen of active) {
    const levels = levelled.includes(gen);
    if (to <= gen.through_ledger) continue;
    await patchTokenHistoryState(ch, gen.generation, levels ? { through_ledger: to, levels_through: to } : { through_ledger: to });
  }
  return { to, changes: written };
}
