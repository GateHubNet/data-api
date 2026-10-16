import { NodeThrottledError } from '@gatehub/data-api-shared';
import { ArgumentsHost, BadRequestException, HttpException, NotFoundException } from '@nestjs/common';
import { badRequest, notFound, RateLimitError, RippleHttpError } from './errors';
import { resetFailureLog } from './failure-log';
import { RippleErrorFilter } from './ripple-error.filter';

interface Reply {
  status?: number;
  body?: unknown;
  headers: Record<string, unknown>;
  ended?: boolean;
}

/** Runs the filter against a fake Express response and returns what it sent. */
function render(
  exception: unknown,
  headers: Record<string, unknown> = {},
  headersSent = false,
  logger: { error: (...args: unknown[]) => void; warn: (...args: unknown[]) => void } = {
    error: () => undefined,
    warn: () => undefined,
  },
): Reply {
  const reply: Reply = { headers: { ...headers } };
  const res = {
    headersSent,
    end: () => (reply.ended = true),
    setHeader: (name: string, value: unknown) => (reply.headers[name] = value),
    getHeader: (name: string) => reply.headers[name],
    status(code: number) {
      reply.status = code;
      return this;
    },
    json(body: unknown) {
      reply.body = body;
    },
  };
  const host = {
    switchToHttp: () => ({ getResponse: () => res, getRequest: () => ({ method: 'GET', originalUrl: '/v2/x' }) }),
  } as unknown as ArgumentsHost;
  const filter = new RippleErrorFilter();
  (filter as unknown as { logger: typeof logger }).logger = logger;
  filter.catch(exception, host);
  return reply;
}

describe('RippleErrorFilter', () => {
  it('renders a RippleHttpError with its status and message', () => {
    expect(render(badRequest('invalid ledger identifier'))).toMatchObject({
      status: 400,
      body: { result: 'error', message: 'invalid ledger identifier' },
    });
    expect(render(notFound('ledger not found'))).toMatchObject({
      status: 404,
      body: { result: 'error', message: 'ledger not found' },
    });
    expect(render(new RippleHttpError(500, 'Could not retrieve ledger.'))).toMatchObject({
      status: 500,
      body: { result: 'error', message: 'Could not retrieve ledger.' },
    });
  });

  it('keeps the status of another 4xx HttpException and uses its message', () => {
    expect(render(new NotFoundException('Cannot GET /x'))).toMatchObject({
      status: 404,
      body: { result: 'error', message: 'Cannot GET /x' },
    });
    expect(render(new HttpException('teapot', 418))).toMatchObject({
      status: 418,
      body: { result: 'error', message: 'teapot' },
    });
  });

  it('joins a list of validation messages', () => {
    const exception = new BadRequestException({ message: ['limit must be a number', 'start is invalid'] });
    expect(render(exception)).toMatchObject({
      status: 400,
      body: { result: 'error', message: 'limit must be a number, start is invalid' },
    });
  });

  it('falls back to the exception message when the response has none', () => {
    expect(render(new HttpException({ code: 7 }, 400))).toMatchObject({
      status: 400,
      body: { result: 'error', message: 'Http Exception' },
    });
  });

  it('says "Missing or invalid API key." for every 401', () => {
    expect(render(new HttpException('whatever', 401))).toMatchObject({
      status: 401,
      body: { result: 'error', message: 'Missing or invalid API key.' },
    });
  });

  it('words a RateLimitError as the original rate limiter: the seconds left, with two decimals', () => {
    expect(render(new RateLimitError(16.4321))).toMatchObject({
      status: 429,
      body: { error: 'Rate limit exceeded, retry in 16.43sec' },
    });
    expect(render(new RateLimitError(0.4)).body).toEqual({ error: 'Rate limit exceeded, retry in 0.40sec' });
    expect(render(new RateLimitError(60)).body).toEqual({ error: 'Rate limit exceeded, retry in 60.00sec' });
    expect(render(new RateLimitError(2.005)).body).toEqual({
      error: `Rate limit exceeded, retry in ${(2.005).toFixed(2)}sec`,
    });
  });

  it('words another 429 with the whole seconds of its Retry-After', () => {
    expect(
      render(new HttpException('ThrottlerException: Too Many Requests', 429), { 'Retry-After': 17 }),
    ).toMatchObject({
      status: 429,
      body: { error: 'Rate limit exceeded, retry in 17.00sec' },
    });
    expect(render(new HttpException('x', 429), { 'Retry-After': '2.2' }).body).toEqual({
      error: 'Rate limit exceeded, retry in 2.20sec',
    });
    expect(render(new HttpException('x', 429)).body).toEqual({ error: 'Rate limit exceeded, retry in 1.00sec' });
  });

  it.each([
    ['an Error', new Error('secret detail')],
    ['a string', 'secret detail'],
    ['undefined', undefined],
    ['a 5xx HttpException', new HttpException('secret detail', 503)],
  ])('answers %s with a 500 "internal error" that does not leak the cause', (_name, exception) => {
    const reply = render(exception);
    expect(reply.status).toBe(500);
    expect(reply.body).toEqual({ result: 'error', message: 'internal error' });
  });

  it('only ends a response that has already begun, since a Ripple body can no longer be sent', () => {
    const reply = render(new Error('stream broke'), {}, true);
    expect(reply.ended).toBe(true);
    expect(reply.status).toBeUndefined();
    expect(reply.body).toBeUndefined();
    expect(reply.headers['Cache-Control']).toBeUndefined();
  });

  it('never lets a shared cache keep an error', () => {
    expect(render(badRequest('x')).headers['Cache-Control']).toBe('no-store');
    expect(render(new Error('x')).headers['Cache-Control']).toBe('no-store');
  });

  it('logs a failure caused by a rate-limited node once per pause, at warn and without a stack, and still answers 500', () => {
    resetFailureLog();
    const logger = { error: jest.fn(), warn: jest.fn() };
    for (let i = 0; i < 3; i++) {
      const reply = render(new NodeThrottledError(['wss://node.example'], 60_000, 'rate limit'), {}, false, logger);
      expect(reply).toMatchObject({ status: 500, body: { result: 'error', message: 'internal error' } });
    }
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0]).toHaveLength(1);
    expect(logger.error).not.toHaveBeenCalled();
  });
});
