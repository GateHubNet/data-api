import { Controller, Get, Header, Inject, InternalServerErrorException, Logger } from '@nestjs/common';

/** What `/metricz` serves: the text exposition of the app's registry. Each app's `PrometheusService` is one. */
export interface MetricsSource {
  getMetrics(): Promise<string>;
}

/** The token of the app's `MetricsSource`: its module provides it with `useExisting` its own `PrometheusService`. */
export const METRICS_SOURCE = Symbol('METRICS_SOURCE');

/** `GET /metricz` of the metricz app of every app (api, syncer, exporter): the metrics of its `MetricsSource`. */
@Controller()
export class PrometheusController {
  private readonly log = new Logger(PrometheusController.name);

  constructor(@Inject(METRICS_SOURCE) private readonly service: MetricsSource) {}

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
