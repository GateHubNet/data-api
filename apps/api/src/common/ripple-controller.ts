import {
  applyDecorators,
  CallHandler,
  Controller,
  ExecutionContext,
  HttpException,
  Injectable,
  Logger,
  NestInterceptor,
  SetMetadata,
  UseFilters,
  UseInterceptors,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { catchError, Observable, throwError } from 'rxjs';
import { RippleHttpError } from './errors';
import { RippleErrorFilter } from './ripple-error.filter';

/** Swagger tag of a controller: the first segment after `v2/` of its first path (`v2/accounts/:id` -> `accounts`). */
function tagOf(paths: string[]): string {
  const first = (paths[0] ?? 'ripple').replace(/^\/+/, '').replace(/^v2\/?/, '');
  return first.split('/')[0] || 'v2';
}

/**
 * The controller of a Ripple endpoint: `@Controller(paths)`, the Ripple error filter and a Swagger tag. The paths are
 * written out in full (`v2/ledgers`): the app has no global prefix and no URI versioning, so the `/v2` of the data API
 * is part of the route.
 *
 * The filter is attached to the controller because the toolbox `bootstrap()` registers its own global
 * `HttpExceptionFilter`, which would answer `{"error":{"key","message"}}`; a controller-level filter takes precedence.
 */
export function RippleController(...paths: string[]): ClassDecorator {
  return applyDecorators(
    Controller(paths.length > 1 ? paths : paths[0]),
    UseFilters(RippleErrorFilter),
    ApiTags(tagOf(paths)),
  ) as ClassDecorator;
}

const RIPPLE_FAILURE_MESSAGE = 'ripple:failure-message';

/** Turns an error of the route into the route's own Ripple failure message. */
@Injectable()
export class RippleRouteInterceptor implements NestInterceptor {
  private readonly logger = new Logger('RippleRoute');

  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const failureMessage = this.reflector.get<string>(RIPPLE_FAILURE_MESSAGE, context.getHandler());
    return next.handle().pipe(
      catchError((err: unknown) => {
        if (err instanceof HttpException) return throwError(() => err);
        const req = context.switchToHttp().getRequest<Request>();
        this.logger.error(
          `${req.method} ${req.originalUrl} failed: ${err instanceof Error ? err.message : String(err)}`,
          err instanceof Error ? err.stack : undefined,
        );
        return throwError(() => new RippleHttpError(500, failureMessage));
      }),
    );
  }
}

/**
 * The failure message of a Ripple route (`Could not retrieve ledger.`): an error of the route that is not an
 * HttpException becomes a 500 `{"result":"error","message":failureMessage}`, and its cause is logged, not sent.
 * HttpExceptions (`badRequest`, `notFound`, ...) pass through with their own status and message.
 */
export function RippleRoute(failureMessage: string): MethodDecorator {
  return applyDecorators(
    SetMetadata(RIPPLE_FAILURE_MESSAGE, failureMessage),
    UseInterceptors(RippleRouteInterceptor),
  ) as MethodDecorator;
}
