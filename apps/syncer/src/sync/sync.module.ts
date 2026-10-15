import { ParsingService } from '@gatehub/data-api-shared';
import { Module } from '@nestjs/common';
import { ClickHouseDataProcessorService } from '../processor/clickhouse-data-processor.service';
import { XrplConnectionService } from '../xrpl/xrpl-connection.service';
import { LedgerIngestor } from './ledger-ingestor';
import { SyncProcessorService } from './sync-processor.service';

@Module({
  providers: [
    XrplConnectionService,
    ParsingService,
    ClickHouseDataProcessorService,
    LedgerIngestor,
    SyncProcessorService,
  ],
  exports: [SyncProcessorService, XrplConnectionService, ClickHouseDataProcessorService],
})
export class SyncModule {}
