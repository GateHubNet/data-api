import { All, Module, Req } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
// A type-only import: with decorator metadata a plain one is required at runtime, and `express` is not our dependency.
import type { Request } from 'express';
import { notFound } from './errors';
import { RippleController } from './ripple-controller';

/**
 * The catch-all of `/v2`: a route nothing else serves is `404 {"result":"error","message":"Cannot GET /v2/nope"}`
 * instead of the toolbox's `{"error":{...}}` page.
 *
 * Express matches routes in the order Nest registers them, so this controller must be registered LAST: it lives in its
 * own `NotFoundModule`, which `AppModule` imports after every endpoint module. A module added behind it would be
 * shadowed (`app.module.spec.ts` guards the order). It is still a /v2 route, so the API key and the rate limit apply.
 */
@ApiExcludeController()
@RippleController('v2')
export class NotFoundController {
  @All(['', '*'])
  notFound(@Req() req: Request): never {
    throw notFound(`Cannot ${req.method} ${req.originalUrl}`);
  }
}

@Module({ controllers: [NotFoundController] })
export class NotFoundModule {}
