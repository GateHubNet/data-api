import { Controller, Get, Logger, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { TransactionHashQueryDto, TransactionsQueryDto } from './transactions.dto';
import { TransactionsService } from './transactions.service';

@ApiTags('transactions')
@Controller({ version: '2', path: 'transactions' })
export class TransactionsController {
  private readonly logger = new Logger(TransactionsController.name);

  constructor(private readonly service: TransactionsService) {}

  @Get()
  @ApiOperation({ summary: 'List transactions', description: 'Filter by type/result/time window with cursor pagination.' })
  getTransactions(@Query() query: TransactionsQueryDto) {
    this.logger.log('GET /transactions');
    return this.service.getTransactions(query);
  }

  @Get(':hash')
  @ApiOperation({ summary: 'Get a transaction by hash' })
  getTransactionByHash(@Param('hash') hash: string, @Query() query: TransactionHashQueryDto) {
    this.logger.log(`GET /transactions/${hash}`);
    return this.service.getTransactionByHash(hash, query);
  }
}
