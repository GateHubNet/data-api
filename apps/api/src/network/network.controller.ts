import { Controller, Get, Logger, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { TopCurrenciesQueryDto, VolumeQueryDto } from './network.dto';
import { NetworkService } from './network.service';

@ApiTags('network')
@Controller({ version: '2', path: 'network' })
export class NetworkController {
  private readonly logger = new Logger(NetworkController.name);

  constructor(private readonly service: NetworkService) {}

  @Get('payment_volume')
  @ApiOperation({ summary: 'Total payment volume for a currency' })
  getPaymentVolume(@Query() query: VolumeQueryDto) {
    this.logger.log('GET /network/payment_volume');
    return this.service.getPaymentVolume(query);
  }

  @Get('exchange_volume')
  @ApiOperation({ summary: 'Total DEX exchange volume for a base currency' })
  getExchangeVolume(@Query() query: VolumeQueryDto) {
    this.logger.log('GET /network/exchange_volume');
    return this.service.getExchangeVolume(query);
  }

  @Get('top_currencies')
  @ApiOperation({ summary: 'Top issued currencies by trustline count' })
  getTopCurrencies(@Query() query: TopCurrenciesQueryDto) {
    this.logger.log('GET /network/top_currencies');
    return this.service.getTopCurrencies(query);
  }
}
