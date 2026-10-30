import { Module } from '@nestjs/common';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';

/** `GET /v2/payments` and `GET /v2/payments/:currency`. `PaymentsService` is exported for the transfers of a token. */
@Module({
  controllers: [PaymentsController],
  providers: [PaymentsService],
  exports: [PaymentsService],
})
export class PaymentsModule {}
