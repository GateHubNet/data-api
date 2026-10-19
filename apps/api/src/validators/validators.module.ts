import { Module } from '@nestjs/common';
import { ValidatorDirectoryService } from './validator-directory.service';
import { ValidatorsController } from './validators.controller';

/**
 * `GET /v2/network/validators/summary`. The `ValidatorDirectoryService` is the table of every validator that the routes of
 * the validators and of the amendments read, and is exported for them.
 */
@Module({
  controllers: [ValidatorsController],
  providers: [ValidatorDirectoryService],
  exports: [ValidatorDirectoryService],
})
export class ValidatorsModule {}
