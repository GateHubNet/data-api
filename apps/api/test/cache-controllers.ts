import { Get } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { CacheService } from '../src/common/cache.service';
import { RippleController } from '../src/common/ripple-controller';
import { RATES_CACHE } from '../src/exchanges/rates.module';

/**
 * A test-only route that empties the app's `CacheService` and the one of the rates computed on read (`RATES_CACHE`, found
 * in the `RatesModule` through the `ModuleRef`), for a suite that changes what the app caches behind its back (the rollup
 * coverage of an account is kept for 60 s; the rates computed on read as well). Like `test-controllers.ts`
 * this file is imported through the `controllers` callback of `startHarness`, so that its `CacheService` is the one of
 * the app's module registry:
 *
 *   startHarness({ controllers: async () => (await import('./cache-controllers')).CACHE_CONTROLLERS })
 */
@RippleController('v2/test-cache')
export class CacheController {
  constructor(
    private readonly cache: CacheService,
    private readonly moduleRef: ModuleRef,
  ) {}

  @Get('clear')
  clear(): { result: string } {
    this.cache.clear();
    this.moduleRef.get<CacheService>(RATES_CACHE, { strict: false }).clear();
    return { result: 'success' };
  }
}

export const CACHE_CONTROLLERS = [CacheController];
