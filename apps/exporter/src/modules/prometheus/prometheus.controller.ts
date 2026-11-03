import { Controller, Get, Header, InternalServerErrorException, Logger } from '@nestjs/common';
import { PrometheusService } from './prometheus.service';

@Controller()
export class PrometheusController {
  private readonly log = new Logger(PrometheusController.name);

  constructor(private readonly service: PrometheusService) {}

  @Get('metricz')
  @Header('content-type', 'text/plain; version=0.0.4; charset=utf-8')
  async getMetrics(): Promise<string> {
    try {
      return await this.service.getMetrics();
    } catch (error) {
      this.log.error(error);
      throw new InternalServerErrorException('Failed fetching metrics.');
    }
  }
}
