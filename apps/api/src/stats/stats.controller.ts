import { Controller, Get, Logger, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CommonQueryDto } from '../common/query.dto';
import { StatsService } from './stats.service';

@ApiTags('stats')
@Controller({ version: '2', path: 'stats' })
export class StatsController {
  private readonly logger = new Logger(StatsController.name);

  constructor(private readonly service: StatsService) {}

  @Get()
  @ApiOperation({ summary: 'Daily network activity counts', description: 'Payments, exchanges and accounts-created per day.' })
  getStats(@Query() query: CommonQueryDto) {
    this.logger.log('GET /stats');
    return this.service.getStats(query);
  }
}
