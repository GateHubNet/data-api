import { Controller, Get, Res, ServiceUnavailableException } from '@nestjs/common';
import { HealthCheck } from '@nestjs/terminus';
import { LivelinessService } from './liveliness.service';

/** The part of the express response the probe uses (the app has no express types of its own). */
interface StatusResponse {
  status(code: number): unknown;
}

@Controller('liveliness')
export class LivelinessController {
  constructor(private readonly health: LivelinessService) {}

  /**
   * 200 with the terminus result when every indicator is up, 503 with the same result (`status: 'error'`, `info`,
   * `error`, `details`) when one is down (ruling R101). Terminus reports the failure as a `ServiceUnavailableException`
   * that carries that result; the global toolbox filter would turn it into `{"error":{"key":"SERVICEUNAVAILABLEEXCEPTION"}}`
   * and drop the reason, so it is answered here.
   */
  @Get('healthz')
  @HealthCheck()
  async check(@Res({ passthrough: true }) res: StatusResponse): Promise<unknown> {
    try {
      return await this.health.livelinessCheck();
    } catch (err) {
      if (!(err instanceof ServiceUnavailableException)) throw err;
      res.status(503);
      return err.getResponse();
    }
  }
}
