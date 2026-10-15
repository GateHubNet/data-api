import { HttpException } from '@nestjs/common';

/**
 * An error with a Ripple message. `RippleErrorFilter` renders it as `{"result":"error","message":"<message>"}` with
 * its status: 4xx for the caller's mistakes, 500 for a failure the route reports with its own message.
 */
export class RippleHttpError extends HttpException {
  constructor(status: number, message: string) {
    super({ result: 'error', message }, status);
  }
}

/** 400 with the exact message of the Ripple route (`invalid ledger identifier`, ...). */
export const badRequest = (message: string): RippleHttpError => new RippleHttpError(400, message);

/** 404 with the exact message of the Ripple route (`ledger not found`, ...). */
export const notFound = (message: string): RippleHttpError => new RippleHttpError(404, message);
