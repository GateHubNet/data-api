import { Module } from '@nestjs/common';
import { PathPaymentsController } from './path-payments.controller';
import { PathPaymentsService } from './path-payments.service';

/** `GET /v2/path_payments`. */
@Module({
  controllers: [PathPaymentsController],
  providers: [PathPaymentsService],
})
export class PathPaymentsModule {}
