import { Controller, Get } from '@nestjs/common';
import { HealthCheck } from '@nestjs/terminus';
import { LivelinessService } from './liveliness.service';

@Controller('liveliness')
export class LivelinessController {
  constructor(private readonly health: LivelinessService) {}

  @Get('healthz')
  @HealthCheck()
  check() {
    return this.health.livelinessCheck();
  }
}
