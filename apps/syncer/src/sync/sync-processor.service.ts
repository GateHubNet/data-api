import { wait } from '@gatehub/data-api-shared';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { SYNCER_CONFIG, SyncerConfig } from '../config/syncer.config';
import { PrometheusService } from '../modules/prometheus/prometheus.service';
import { ClickHouseDataProcessorService } from '../processor/clickhouse-data-processor.service';
import { XrplConnectionService } from '../xrpl/xrpl-connection.service';
import { LedgerIngestor } from './ledger-ingestor';

const SKIP_WINDOW = 10_000;

/**
 * Orchestrates ingestion:
 *  - backfill(): a bounded worker pool draining a [from, to] cursor, skipping
 *    ledgers already present (windowed lookup), retrying transient failures, and
 *    recording any ledger that exhausts its retries so it can be re-run.
 *  - subscribeLive(): a single serial consumer of the ledgerClosed stream that
 *    cannot stall (the old `isWorking` race is gone — we use a promise chain).
 */
@Injectable()
export class SyncProcessorService {
  private readonly logger = new Logger(SyncProcessorService.name);

  constructor(
    @Inject(SYNCER_CONFIG) private readonly config: SyncerConfig,
    private readonly xrpl: XrplConnectionService,
    private readonly ingestor: LedgerIngestor,
    private readonly processor: ClickHouseDataProcessorService,
    private readonly metrics: PrometheusService,
  ) {}

  /** Narrows [from,to] to this instance's contiguous shard (for running N syncers in parallel). */
  shardRange(from: number, to: number): { from: number; to: number } {
    const { shardIndex, shardTotal } = this.config;
    if (shardTotal <= 1) return { from, to };
    const total = to - from + 1;
    const size = Math.ceil(total / shardTotal);
    const shardFrom = from + shardIndex * size;
    const shardTo = Math.min(to, shardFrom + size - 1);
    return { from: shardFrom, to: shardTo };
  }

  async backfill(fromArg: number, toArg: number): Promise<void> {
    const { from, to } = this.shardRange(fromArg, toArg);
    if (from > to) {
      this.logger.log(`Shard ${this.config.shardIndex}/${this.config.shardTotal} is empty for ${fromArg}..${toArg}`);
      return;
    }
    const workers = Math.max(1, this.config.backfillWorkers);
    const batch = Math.max(1, this.config.backfillBatchLedgers);
    this.logger.log(
      `Backfill ${from}..${to} (${to - from + 1} ledgers) with ${workers} workers, batch ${batch}` +
        (this.config.shardTotal > 1 ? `, shard ${this.config.shardIndex}/${this.config.shardTotal}` : ''),
    );

    let cursor = from;
    let windowStart = -1;
    let inserted = new Set<number>();
    let windowLoad: Promise<void> | undefined;
    const failed: number[] = [];
    let done = 0;
    let maxSynced = 0;
    const start = Date.now();

    // Single-flight window refresh: only one worker loads the skip-window at a time;
    // others await the same promise (fixes the shared-state race in the old version).
    const refreshWindowIfNeeded = async (index: number): Promise<void> => {
      while (!(index >= windowStart && index < windowStart + SKIP_WINDOW)) {
        if (windowLoad) {
          await windowLoad;
          continue;
        }
        const loadStart = index;
        windowLoad = this.processor.getInsertedLedgers(loadStart, loadStart + SKIP_WINDOW - 1).then((set) => {
          inserted = set;
          windowStart = loadStart;
          windowLoad = undefined;
        });
        await windowLoad;
      }
    };

    const claimNext = (): number | undefined => (cursor <= to ? cursor++ : undefined);

    const runWorker = async (): Promise<void> => {
      for (;;) {
        const index = claimNext();
        if (index === undefined) return;

        await refreshWindowIfNeeded(index);
        if (inserted.has(index)) {
          done++;
          continue;
        }

        try {
          this.logger.log(`Backfilling ledger ${index}`);
          const { ledger, parsed } = await this.ingestor.fetchAndParse(index);
          this.processor.enqueueLedger(ledger, parsed);
          await this.processor.maybeFlush(batch);
          done++;
          if (index > maxSynced) {
            maxSynced = index;
            this.metrics.latestSyncedLedger.set(index);
          }
          this.metrics.ledgersProcessed.inc();
          if (done % 1000 === 0) {
            const rate = done / ((Date.now() - start) / 1000);
            this.logger.log(`Backfilled ${done} ledgers (${rate.toFixed(1)}/s), cursor ${index}`);
          }
        } catch (err) {
          this.logger.error(`Ledger ${index} permanently failed after retries: ${String(err)}`);
          failed.push(index);
        }

        if (this.config.fetchThrottleMs > 0) await wait(this.config.fetchThrottleMs);
      }
    };

    await Promise.all(Array.from({ length: workers }, () => runWorker()));
    await this.processor.flush(); // drain the tail of the buffer

    this.logger.log(`Backfill complete: ${done} ledgers in ${((Date.now() - start) / 1000).toFixed(1)}s`);
    if (failed.length > 0) {
      this.logger.warn(`${failed.length} ledgers failed and were not indexed: ${failed.slice(0, 50).join(', ')}${failed.length > 50 ? '…' : ''}`);
    }
  }

  subscribeLive(): void {
    this.logger.log('Subscribing to live ledgers');
    let chain: Promise<void> = Promise.resolve();

    this.xrpl.ledger$.subscribe((ledger) => {
      const index = ledger.ledger_index;
      // Serialize processing via a promise chain — no shared mutable "isWorking" flag,
      // so a ledger arriving while idle can never be dropped (review M7). Live ledgers
      // flush immediately (insertLedger) since they arrive ~1 every 3-4s.
      chain = chain
        .then(async () => {
          const { ledger: l, parsed } = await this.ingestor.fetchAndParse(index);
          await this.processor.insertLedger(l, parsed);
          this.metrics.latestSyncedLedger.set(index);
          this.metrics.ledgersProcessed.inc();
        })
        .catch((err) => this.logger.error(`Live ledger ${index} failed: ${String(err)}`));
    });

    void this.xrpl.subscribeToLedgers();
  }
}
