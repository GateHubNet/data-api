import { Global, Module } from '@nestjs/common';
import { ValidatorsModule } from '../validators/validators.module';
import { FeatureCoverageService } from './feature-coverage.service';

/**
 * `FeatureCoverageService`, global so that the endpoint modules of a feature need no import to state its coverage. It
 * reads the enable ledgers of the amendments through the `AmendmentsService` of the `ValidatorsModule`.
 */
@Global()
@Module({
  imports: [ValidatorsModule],
  providers: [FeatureCoverageService],
  exports: [FeatureCoverageService],
})
export class FeatureCoverageModule {}
