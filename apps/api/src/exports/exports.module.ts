import { GcsExportStorage } from '@gatehub/data-api-shared';
import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { ApiConfig } from '../config/api.config';
import { ExportableRoutes } from './exportable-routes';
import { ExportsController } from './exports.controller';
import { EXPORT_STORAGE, ExportsService } from './exports.service';

/**
 * `POST /v2/exports` and `GET /v2/exports/{id}` (ticket #15). The storage is the Google Cloud Storage bucket of
 * `GH_EXPORT_BUCKET`, or none when it is empty (exports are off); the e2e harness puts an in-memory store in its place.
 */
@Module({
  imports: [DiscoveryModule],
  controllers: [ExportsController],
  providers: [
    ExportableRoutes,
    ExportsService,
    {
      provide: EXPORT_STORAGE,
      useFactory: (config: ApiConfig) =>
        config.exportBucket === '' ? null : new GcsExportStorage({ bucket: config.exportBucket }),
      inject: [ApiConfig],
    },
  ],
})
export class ExportsModule {}
