import { ClickHouseService, GcsExportStorage, ShutdownSignals } from '@gatehub/data-api-shared';
import { Injectable, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ExporterConfig } from './config/exporter.config';
import { ExportWorker } from './export-worker';
import { PrometheusService } from './modules/prometheus/prometheus.service';

/**
 * The `ExportWorker` of the app: the network's database, the Google Cloud Storage bucket of `GH_EXPORT_BUCKET` and the
 * api of `GH_API_URL`. It starts once the app is up and stops on shutdown (module destroy, or SIGTERM / SIGINT through
 * `ShutdownSignals`), which queues the job in hand again.
 */
@Injectable()
export class ExportWorkerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly worker: ExportWorker;

  constructor(
    config: ExporterConfig,
    ch: ClickHouseService,
    metrics: PrometheusService,
    private readonly signals: ShutdownSignals,
  ) {
    this.worker = new ExportWorker({
      ch,
      storage: new GcsExportStorage({ bucket: config.exportBucket }),
      network: config.network,
      apiUrl: config.apiUrl,
      apiKey: config.exporterApiKey,
      pageSize: config.exportPageSize,
      pollMs: config.exportPollMs,
      requestTimeoutMs: config.exportRequestTimeoutMs,
      maxRows: { csv: config.exportMaxRowsCsv, pdf: config.exportMaxRowsPdf },
      onFinished: (status, rows, seconds) => metrics.jobFinished(status, rows, seconds),
    });
  }

  onApplicationBootstrap(): void {
    this.signals.register('export-worker', () => this.worker.stop());
    this.worker.start();
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker.stop();
  }
}
