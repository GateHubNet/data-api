import { ClickHouseService, LedgerSource, LedgerWriter, NodeClient, ParseContext } from '@gatehub/data-api-shared';
import { Global, Module } from '@nestjs/common';
import { NODE_CLIENT, PARSE_CONTEXT, SyncerConfig } from '../config/syncer.config';
import { INGEST_STATUS } from '../modules/liveliness/ingest-status';
import { LEDGER_SOURCE, LiveRunner } from './live-runner';
import { RpcLedgerSource } from './rpc-ledger-source';

/**
 * The `ingest` worker: the `LiveRunner` over the node client, writing with a `LedgerWriter`.
 *
 * Global, and it exports `INGEST_STATUS` (the runner itself), so that the liveliness probe of the core module sees the
 * runner's state and lag; without this module the probe only checks ClickHouse.
 */
@Global()
@Module({
  providers: [
    {
      provide: LEDGER_SOURCE,
      useFactory: (client: NodeClient, cfg: SyncerConfig): LedgerSource =>
        new RpcLedgerSource(client, { fetchTimeoutMs: cfg.ledgerFetchTimeoutMs }),
      inject: [NODE_CLIENT, SyncerConfig],
    },
    {
      provide: LedgerWriter,
      useFactory: (ch: ClickHouseService, ctx: ParseContext) => new LedgerWriter(ch, ctx),
      inject: [ClickHouseService, PARSE_CONTEXT],
    },
    LiveRunner,
    { provide: INGEST_STATUS, useExisting: LiveRunner },
  ],
  exports: [INGEST_STATUS],
})
export class IngestModule {}
