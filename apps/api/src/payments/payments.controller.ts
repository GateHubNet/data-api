import { Controller, Get, Logger, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PaymentsQueryDto } from './payments.dto';
import { PaymentsService } from './payments.service';

@ApiTags('payments')
@Controller({ version: '2', path: 'payments' })
export class PaymentsController {
  private readonly logger = new Logger(PaymentsController.name);

  constructor(private readonly service: PaymentsService) {}

  @Get()
  @ApiOperation({ summary: 'List payments', description: 'Returns payment transactions, newest- or oldest-first, with cursor pagination.' })
  getPayments(@Query() query: PaymentsQueryDto) {
    this.logger.log('GET /payments');
    return this.service.getPayments(query);
  }

  @Get(':currency')
  @ApiOperation({ summary: 'List payments for a currency' })
  getPaymentsByCurrency(@Param('currency') currency: string, @Query() query: PaymentsQueryDto) {
    this.logger.log(`GET /payments/${currency}`);
    return this.service.getPayments({ ...query, currency });
  }
}
