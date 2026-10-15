import { Controller, Get, Logger, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ExchangeRatesQueryDto, ExchangesQueryDto, NormalizeQueryDto } from './exchanges.dto';
import { ExchangesService } from './exchanges.service';

@ApiTags('exchanges')
@Controller({ version: '2' })
export class ExchangesController {
  private readonly logger = new Logger(ExchangesController.name);

  constructor(private readonly service: ExchangesService) {}

  @Get('exchanges')
  @ApiOperation({ summary: 'List all DEX trades' })
  getAllExchanges(@Query() query: ExchangesQueryDto) {
    this.logger.log('GET /exchanges');
    return this.service.getAllExchanges(query);
  }

  @Get('exchanges/:base/:counter')
  @ApiOperation({ summary: 'Trades or OHLC/VWAP candles for a currency pair', description: 'Pass ?interval= for candles; omit for raw trades. Asset format: CURRENCY or CURRENCY+ISSUER.' })
  getExchanges(@Param('base') base: string, @Param('counter') counter: string, @Query() query: ExchangesQueryDto) {
    this.logger.log(`GET /exchanges/${base}/${counter}`);
    return this.service.getExchanges(base, counter, query);
  }

  @Get('exchange_rates/:base/:counter')
  @ApiOperation({ summary: 'Latest rate or period VWAP for a pair' })
  getExchangeRates(@Param('base') base: string, @Param('counter') counter: string, @Query() query: ExchangeRatesQueryDto) {
    this.logger.log(`GET /exchange_rates/${base}/${counter}`);
    return this.service.getExchangeRate(base, counter, query);
  }

  @Get('normalize')
  @ApiOperation({ summary: 'Convert an amount between two assets at the current/at-date rate' })
  normalize(@Query() query: NormalizeQueryDto) {
    this.logger.log('GET /normalize');
    return this.service.normalize(query);
  }
}
