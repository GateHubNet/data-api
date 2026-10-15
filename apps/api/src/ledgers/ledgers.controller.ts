import { Controller, Get, Logger, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CommonQueryDto } from '../common/query.dto';
import { LedgersService } from './ledgers.service';

@ApiTags('ledgers')
@Controller({ version: '2', path: 'ledgers' })
export class LedgersController {
  private readonly logger = new Logger(LedgersController.name);

  constructor(private readonly service: LedgersService) {}

  @Get()
  @ApiOperation({ summary: 'List ledgers in a time range' })
  getLedgers(@Query() query: CommonQueryDto) {
    this.logger.log('GET /ledgers');
    return this.service.getLedgers(query);
  }

  @Get(':identifier')
  @ApiOperation({ summary: 'Get a ledger by index, hash or date' })
  getLedger(@Param('identifier') identifier: string) {
    this.logger.log(`GET /ledgers/${identifier}`);
    return this.service.getLedger(identifier);
  }
}
