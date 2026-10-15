import { runMigrations } from '@gatehub/data-api-shared';
import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { SYNCER_CONFIG, SyncerConfig } from './config/syncer.config';
import { SyncProcessorService } from './sync/sync-processor.service';
import { XrplConnectionService } from './xrpl/xrpl-connection.service';

/**
 * Boots the ingestion pipeline once the Nest app is ready. The HTTP server
 * (liveliness + metrics) keeps running independently so the container stays
 * probeable for the whole backfill.
 */
@Injectable()
export class AppService implements OnApplicationBootstrap {
  private readonly logger = new Logger(AppService.name);

  constructor(
    @Inject(SYNCER_CONFIG) private readonly config: SyncerConfig,
    private readonly xrpl: XrplConnectionService,
    private readonly sync: SyncProcessorService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.config.runMigrationsOnBoot) {
      this.logger.log('Applying ClickHouse schema migrations…');
      await runMigrations();
    }

    const serverInfo = await this.xrpl.xrplClient.request({ command: 'server_info' });
    const completeLedgers = serverInfo.result.info.complete_ledgers;
    const [serverFromRaw, serverToRaw] = completeLedgers.split('-');
    const serverFrom = Number(serverFromRaw);
    const serverTo = Number(serverToRaw);
    this.logger.log(`Node complete_ledgers: ${completeLedgers}`);

    if (this.config.subscribeLive) {
      this.sync.subscribeLive();
    }

    if (this.config.backfillEnabled) {
      let from = this.config.backfillStartLedger ?? serverFrom;
      let to = this.config.backfillEndLedger ?? serverTo;

      if (from < serverFrom) {
        this.logger.warn(`Requested start ${from} is before node history ${serverFrom}; clamping. See docs/backfill.md.`);
        from = serverFrom;
      }
      if (to > serverTo) {
        this.logger.warn(`Requested end ${to} is after node history ${serverTo}; clamping.`);
        to = serverTo;
      }

      // Run the backfill in the background; liveliness/metrics stay responsive.
      void this.sync.backfill(from, to).catch((err) => this.logger.error('Backfill crashed', err));
    }

    if (!this.config.subscribeLive && !this.config.backfillEnabled) {
      this.logger.warn('Neither backfill nor live subscription is enabled — syncer is idle.');
    }
  }
}
