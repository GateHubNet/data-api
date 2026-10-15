import { ForbiddenException, Get, ServiceUnavailableException } from '@nestjs/common';
import { badRequest, notFound } from '../src/common/errors';
import { RippleController, RippleRoute } from '../src/common/ripple-controller';

/**
 * Test-only routes for the error contract, registered by the harness (`startHarness({ controllers })`). They stand for
 * the endpoints of the later tasks: a Ripple controller whose routes succeed, fail with a Ripple error, with a plain
 * Error or with some other HttpException.
 */
@RippleController('v2/test')
export class TestController {
  @Get('ok')
  ok(): { result: string } {
    return { result: 'success' };
  }

  /** Large enough to be compressed. */
  @Get('big')
  big(): { result: string; rows: { index: number; text: string }[] } {
    return { result: 'success', rows: Array.from({ length: 200 }, (_, index) => ({ index, text: 'x'.repeat(40) })) };
  }

  @Get('boom')
  @RippleRoute('Could not retrieve the test data.')
  boom(): never {
    throw new Error('secret clickhouse detail');
  }

  @Get('boom-async')
  @RippleRoute('Could not retrieve the async test data.')
  async boomAsync(): Promise<never> {
    await Promise.resolve();
    throw new Error('secret clickhouse detail');
  }

  /** No `@RippleRoute`: the filter's own fallback message. */
  @Get('boom-plain')
  boomPlain(): never {
    throw new Error('secret clickhouse detail');
  }

  @Get('bad-request')
  @RippleRoute('Could not retrieve the test data.')
  badRequest(): never {
    throw badRequest('invalid test parameter');
  }

  @Get('missing')
  @RippleRoute('Could not retrieve the test data.')
  missing(): never {
    throw notFound('test thing not found');
  }

  @Get('forbidden')
  forbidden(): never {
    throw new ForbiddenException('not for you');
  }

  @Get('unavailable')
  unavailable(): never {
    throw new ServiceUnavailableException('database is down');
  }
}

export const TEST_CONTROLLERS = [TestController];
