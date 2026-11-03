import { Module } from '@nestjs/common';
import { PathPaymentsController } from './path-payments.controller';
import { PathPaymentsService } from './path-payments.service';

/**
 * `GET /v2/path_payments`. `PathPaymentsService` is exported for the path payments of an account
 * (`GET /v2/accounts/:address/path_payments`, a route of the `AccountsModule`).
 */
@Module({
  controllers: [PathPaymentsController],
  providers: [PathPaymentsService],
  exports: [PathPaymentsService],
})
export class PathPaymentsModule {}
