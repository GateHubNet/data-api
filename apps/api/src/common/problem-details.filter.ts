import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Request, Response } from 'express';

/** RFC 7807 problem document. */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  /** Validation messages, when present. */
  errors?: string[];
}

/**
 * Global exception filter that renders every error as `application/problem+json`
 * (RFC 7807) with a consistent shape, instead of Nest's default ad-hoc JSON.
 * 5xx details are not leaked to the client; they're logged server-side.
 */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exception');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    const problem = this.toProblem(exception, req.path);
    if (problem.status >= 500) {
      this.logger.error(`${req.method} ${req.url} -> ${problem.status}`, exception instanceof Error ? exception.stack : String(exception));
    }

    res.status(problem.status).type('application/problem+json').json(problem);
  }

  private toProblem(exception: unknown, path: string): ProblemDetails {
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const title = HttpStatus[status] ? this.titleCase(HttpStatus[status] as string) : 'Error';

      let detail: string | undefined;
      let errors: string[] | undefined;
      if (typeof body === 'string') {
        detail = body;
      } else if (body && typeof body === 'object') {
        const msg = (body as { message?: string | string[] }).message;
        if (Array.isArray(msg)) errors = msg;
        else if (typeof msg === 'string') detail = msg;
      }

      return {
        type: `https://docs.gatehub.net/data-api/errors/${status}`,
        title,
        status,
        detail: detail ?? title,
        instance: path,
        ...(errors ? { errors } : {}),
      };
    }

    return {
      type: 'about:blank',
      title: 'Internal Server Error',
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      detail: 'An unexpected error occurred.',
      instance: path,
    };
  }

  private titleCase(s: string): string {
    return s
      .toLowerCase()
      .split('_')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
  }
}
