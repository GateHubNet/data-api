import {
  ClickHouseService,
  getTxCtid,
  ParsedTransaction,
  retry,
  Table,
  toClickHouseDateTime,
} from '@gatehub/data-api-shared';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Ledger } from 'xrpl/dist/npm/models/ledger';
import { SYNCER_CONFIG, SyncerConfig } from '../config/syncer.config';

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const u32 = (v: unknown): number | null => (v === undefined || v === null ? null : Number(v));

/** Child tables flushed before the ledger "commit marker" rows. */
const CHILD_TABLES = [
  Table.Transactions,
  Table.Payments,
  Table.Exchanges,
  Table.BalanceChanges,
  Table.AffectedAccounts,
  Table.AccountsCreated,
  Table.Offers,
  Table.Issuers,
  Table.Escrows,
  Table.PayChannels,
] as const;

/**
 * Buffers parsed ledgers and writes them to ClickHouse in large batches.
 *
 * Why batch: ClickHouse creates one storage "part" per INSERT. Inserting每-ledger
 * (11 inserts/ledger) over a multi-million-ledger backfill produces an unsustainable
 * number of tiny parts ("too many parts" errors) and wastes round-trips. Buffering N
 * ledgers and flushing one INSERT per table cuts round-trips ~100x and keeps part
 * counts sane.
 *
 * Idempotency: every row carries a natural key (ctid / tx_hash+node_index) and the
 * tables are ReplacingMergeTree, so re-processing a ledger collapses to identical
 * rows. On a mid-batch crash, child rows may be written without their ledger marker —
 * the next run simply re-ingests those ledgers (dedup makes that a no-op).
 */
@Injectable()
export class ClickHouseDataProcessorService {
  private readonly logger = new Logger(ClickHouseDataProcessorService.name);

  private readonly buffers = new Map<string, Record<string, unknown>[]>();
  private ledgerBuffer: Record<string, unknown>[] = [];
  private bufferedLedgers = 0;

  constructor(
    private readonly ch: ClickHouseService,
    @Inject(SYNCER_CONFIG) private readonly config: SyncerConfig,
  ) {
    this.resetBuffers();
  }

  private resetBuffers(): void {
    for (const t of CHILD_TABLES) this.buffers.set(t, []);
    this.ledgerBuffer = [];
    this.bufferedLedgers = 0;
  }

  get bufferedLedgerCount(): number {
    return this.bufferedLedgers;
  }

  /** unix-seconds `date` -> ClickHouse DateTime string. */
  private dt(seconds: number): string {
    return toClickHouseDateTime(seconds);
  }

  /** Immediate single-ledger write (used by live sync). */
  async insertLedger(ledger: Ledger, parsed: ParsedTransaction[]): Promise<void> {
    this.enqueueLedger(ledger, parsed);
    await this.flush();
  }

  /** Buffer one ledger's rows. Synchronous — safe to call from concurrent workers. */
  enqueueLedger(ledger: Ledger, parsed: ParsedTransaction[]): void {
    const networkId = this.config.networkId;
    const closeTimeUnix = Number((ledger as any).close_time); // worker passes unix seconds

    const transactions: Record<string, unknown>[] = [];
    const payments: Record<string, unknown>[] = [];
    const exchanges: Record<string, unknown>[] = [];
    const balanceChanges: Record<string, unknown>[] = [];
    const affectedAccounts: Record<string, unknown>[] = [];
    const accountsCreated: Record<string, unknown>[] = [];
    const offers: Record<string, unknown>[] = [];
    const issuers: Record<string, unknown>[] = [];
    const escrows: Record<string, unknown>[] = [];
    const paychannels: Record<string, unknown>[] = [];

    for (const tx of parsed) {
      const raw = tx.rawTransaction;
      const ctid = getTxCtid(raw.ledger_index, raw.meta!.TransactionIndex, networkId);

      transactions.push({
        ctid,
        hash: raw.hash,
        ledger_index: raw.ledger_index,
        tx_index: raw.meta!.TransactionIndex,
        tx_type: raw.TransactionType,
        account: raw.Account,
        destination: (raw as any).Destination ?? '',
        result: raw.meta!.TransactionResult,
        date: this.dt(raw.date),
        tx_json: JSON.stringify(raw),
        meta_json: JSON.stringify(raw.meta),
      });

      if (tx.payment) {
        const p = tx.payment;
        payments.push({
          ctid,
          tx_hash: p.tx_hash,
          source: p.source,
          destination: p.destination,
          currency: p.currency,
          issuer: p.issuer ?? '',
          amount: num(p.amount),
          delivered_amount: num(p.delivered_amount),
          source_currency: p.source_currency ?? '',
          max_amount: num(p.max_amount),
          fee: num(p.fee),
          source_tag: u32(p.source_tag),
          destination_tag: u32(p.destination_tag),
          invoice_id: p.invoice_id ?? '',
          date: this.dt(p.date),
          ledger_index: p.ledger_index,
          tx_index: p.tx_index,
          client: p.client ?? '',
        });
      }

      for (const e of tx.exchanges) {
        exchanges.push({
          tx_hash: e.tx_hash,
          node_index: e.node_index,
          base_currency: e.base.currency,
          base_issuer: e.base.issuer ?? '',
          base_amount: num(e.base.amount),
          counter_currency: e.counter.currency,
          counter_issuer: e.counter.issuer ?? '',
          counter_amount: num(e.counter.amount),
          rate: num(e.rate),
          buyer: e.buyer,
          seller: e.seller,
          taker: e.taker,
          provider: e.provider,
          sequence: e.sequence,
          date: this.dt(e.date),
          tx_type: e.tx_type,
          tx_index: e.tx_index,
          ledger_index: e.ledger_index,
          client: e.client ?? '',
          autobridged_currency: e.autobridged?.currency ?? '',
          autobridged_issuer: e.autobridged?.issuer ?? '',
        });
      }

      for (const b of tx.balanceChanges) {
        balanceChanges.push({
          account: b.account,
          counterparty: b.counterparty ?? '',
          currency: b.currency,
          change: num(b.change),
          final_balance: num(b.final_balance),
          type: b.type ?? '',
          date: this.dt(b.date),
          ledger_index: b.ledger_index,
          tx_index: b.tx_index,
          node_index: b.node_index,
          tx_hash: b.tx_hash,
          client: b.client ?? '',
        });
      }

      for (const a of tx.affectedAccounts) {
        affectedAccounts.push({
          account: a.account,
          tx_result: a.tx_result,
          tx_type: a.tx_type,
          date: this.dt(a.date),
          ledger_index: a.ledger_index,
          tx_index: a.tx_index,
          tx_hash: a.tx_hash,
          client: a.client ?? '',
        });
      }

      for (const a of tx.accountsCreated) {
        accountsCreated.push({
          account: a.account,
          parent: a.parent,
          balance: num(a.balance),
          date: this.dt(a.date),
          ledger_index: a.ledger_index,
          tx_index: a.tx_index,
          tx_hash: a.tx_hash,
          client: a.client ?? '',
        });
      }

      for (const o of tx.offers) {
        offers.push({
          tx_type: o.tx_type,
          node_type: o.node_type,
          account: o.account,
          offer_sequence: o.offer_sequence,
          expiration: u32(o.expiration),
          book_directory: o.book_directory,
          tx_hash: o.tx_hash,
          date: this.dt(o.date),
          ledger_index: o.ledger_index,
          tx_index: o.tx_index,
          node_index: o.node_index,
          prev_offer_sequence: u32(o.prev_offer_sequence),
          next_offer_sequence: u32(o.next_offer_sequence),
          taker_pays_currency: o.taker_pays?.currency ?? '',
          taker_pays_value: num(o.taker_pays?.value),
          taker_gets_currency: o.taker_gets?.currency ?? '',
          taker_gets_value: num(o.taker_gets?.value),
          rate: num(o.rate),
          pays_change: num(o.pays_change),
          gets_change: num(o.gets_change),
          change_type: o.change_type ?? '',
        });
      }

      for (const t of tx.issuers) {
        issuers.push({
          issuer: t.issuer,
          currency: t.currency,
          counterparty: t.counterparty,
          balance: num(t.balance),
          date: this.dt(t.date),
          ledger_index: t.ledger_index,
        });
      }

      if (tx.escrow) {
        const e = tx.escrow;
        escrows.push({
          tx_hash: e.tx_hash,
          tx_type: e.tx_type,
          account: e.account,
          owner: e.owner ?? '',
          destination: e.destination ?? '',
          amount: num(e.amount),
          fee: num(e.fee),
          flags: e.flags ?? '',
          destination_tag: u32(e.destination_tag),
          source_tag: u32(e.source_tag),
          create_tx_seq: u32(e.create_tx_seq),
          create_tx: e.create_tx ?? '',
          condition: e.condition ?? '',
          fulfillment: e.fulfillment ?? '',
          cancel_after: u32(e.cancel_after),
          finish_after: u32(e.finish_after),
          date: this.dt(e.date),
          ledger_index: e.ledger_index,
          tx_index: e.tx_index,
        });
      }

      if (tx.paychannel) {
        const c = tx.paychannel;
        paychannels.push({
          tx_hash: c.tx_hash,
          tx_type: c.tx_type,
          account: c.account,
          source: c.source ?? '',
          destination: c.destination ?? '',
          channel: c.channel ?? '',
          amount: num(c.amount),
          balance: num(c.balance),
          settle: u32(c.settle),
          destination_tag: u32(c.destination_tag),
          source_tag: u32(c.source_tag),
          fee: num(c.fee),
          flags: u32(c.flags),
          cancel_after: u32(c.cancel_after),
          expiration: u32(c.expiration),
          date: this.dt(c.date),
          ledger_index: c.ledger_index,
          tx_index: c.tx_index,
        });
      }
    }

    // Append to the per-table buffers; the ledger "commit marker" row is buffered
    // separately and only flushed after its child rows (see flush()).
    this.buffers.get(Table.Transactions)!.push(...transactions);
    this.buffers.get(Table.Payments)!.push(...payments);
    this.buffers.get(Table.Exchanges)!.push(...exchanges);
    this.buffers.get(Table.BalanceChanges)!.push(...balanceChanges);
    this.buffers.get(Table.AffectedAccounts)!.push(...affectedAccounts);
    this.buffers.get(Table.AccountsCreated)!.push(...accountsCreated);
    this.buffers.get(Table.Offers)!.push(...offers);
    this.buffers.get(Table.Issuers)!.push(...issuers);
    this.buffers.get(Table.Escrows)!.push(...escrows);
    this.buffers.get(Table.PayChannels)!.push(...paychannels);

    this.ledgerBuffer.push({
      ledger_index: ledger.ledger_index,
      ledger_hash: (ledger as any).ledger_hash ?? (ledger as any).hash ?? '',
      parent_hash: ledger.parent_hash,
      account_hash: ledger.account_hash,
      transaction_hash: ledger.transaction_hash,
      total_coins: String(ledger.total_coins),
      close_time: this.dt(closeTimeUnix),
      close_time_human: ledger.close_time_human ?? '',
      close_time_resolution: ledger.close_time_resolution ?? 0,
      close_flags: (ledger as any).close_flags ?? 0,
      closed: 1,
      parent_close_time: this.dt(Number((ledger as any).parent_close_time) || closeTimeUnix),
      tx_count: parsed.length,
    });
    this.bufferedLedgers++;
  }

  /** Flush the buffers if at least `thresholdLedgers` ledgers are queued. */
  async maybeFlush(thresholdLedgers: number): Promise<void> {
    if (this.bufferedLedgers >= thresholdLedgers) {
      await this.flush();
    }
  }

  /**
   * Write all buffered rows: every child table first (in parallel), then the ledger
   * markers. Buffers are snapshotted and cleared synchronously up-front so concurrent
   * workers can keep enqueuing during the network I/O. The whole batch is retried.
   */
  async flush(): Promise<void> {
    if (this.bufferedLedgers === 0) return;

    const childBatches = CHILD_TABLES.map((t) => ({ table: t as string, rows: this.buffers.get(t)! }));
    const ledgerRows = this.ledgerBuffer;
    const ledgerCount = this.bufferedLedgers;
    this.resetBuffers();

    await retry(
      async () => {
        await Promise.all(childBatches.filter((b) => b.rows.length > 0).map((b) => this.ch.insert(b.table, b.rows)));
        await this.ch.insert(Table.Ledgers, ledgerRows);
      },
      { attempts: 5, onRetry: (err, attempt) => this.logger.warn(`Flush of ${ledgerCount} ledgers failed (attempt ${attempt}): ${String(err)}`) },
    );
  }

  /** Returns the set of ledger indices already present in [from, to]. Used to skip work. */
  async getInsertedLedgers(from: number, to: number): Promise<Set<number>> {
    const rows = await this.ch.query<{ ledger_index: number }>(
      `SELECT ledger_index FROM ${Table.Ledgers} WHERE ledger_index BETWEEN {from:UInt32} AND {to:UInt32}`,
      { from, to },
    );
    return new Set(rows.map((r) => Number(r.ledger_index)));
  }
}
