import { NodeThrottledError } from '@gatehub/data-api-shared';
import {
  BadRequestException,
  CallHandler,
  ExecutionContext,
  Get,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { lastValueFrom, throwError } from 'rxjs';
import { badRequest, RippleHttpError } from './errors';
import { resetFailureLog } from './failure-log';
import { RippleController, RippleRoute, RippleRouteInterceptor } from './ripple-controller';
import { RippleErrorFilter } from './ripple-error.filter';

const FILTERS_METADATA = '__exceptionFilters__';
const INTERCEPTORS_METADATA = '__interceptors__';
const API_TAGS = 'swagger/apiUseTags';

describe('RippleController', () => {
  it('is a controller on the given path with the Ripple filter', () => {
    @RippleController('v2/ledgers')
    class Ledgers {}
    expect(Reflect.getMetadata(PATH_METADATA, Ledgers)).toBe('v2/ledgers');
    expect(Reflect.getMetadata(FILTERS_METADATA, Ledgers)).toEqual([RippleErrorFilter]);
  });

  it('takes several paths', () => {
    @RippleController('v2/ledgers', 'v2/ledger')
    class Ledgers {}
    expect(Reflect.getMetadata(PATH_METADATA, Ledgers)).toEqual(['v2/ledgers', 'v2/ledger']);
  });

  it.each([
    [['v2/ledgers'], 'ledgers'],
    [['/v2/accounts/:address/balances'], 'accounts'],
    [['v2/network/exchange_volume'], 'network'],
    [['v2'], 'v2'],
    [[], 'ripple'],
  ])('tags %j as %s in the swagger document', (paths, tag) => {
    @RippleController(...paths)
    class Anything {}
    expect(Reflect.getMetadata(API_TAGS, Anything)).toEqual([tag]);
  });
});

describe('RippleRoute', () => {
  it('keeps the route and adds the interceptor with the failure message', () => {
    class Controller {
      @Get('thing')
      @RippleRoute('Could not retrieve thing.')
      thing(): void {}
    }
    const handler = Controller.prototype.thing;
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('thing');
    expect(Reflect.getMetadata(INTERCEPTORS_METADATA, handler)).toEqual([RippleRouteInterceptor]);
    expect(Reflect.getMetadata('ripple:failure-message', handler)).toBe('Could not retrieve thing.');
  });
});

describe('RippleRouteInterceptor', () => {
  class Controller {
    @RippleRoute('Could not retrieve thing.')
    thing(): void {}
  }
  const context = {
    getHandler: () => Controller.prototype.thing,
    switchToHttp: () => ({ getRequest: () => ({ method: 'GET', originalUrl: '/v2/thing' }) }),
  } as unknown as ExecutionContext;
  const interceptor = new RippleRouteInterceptor(new Reflector());

  /** What the interceptor lets out when the route fails with `error`. */
  async function failWith(error: unknown): Promise<unknown> {
    const next: CallHandler = { handle: () => throwError(() => error) };
    return lastValueFrom(interceptor.intercept(context, next)).then(
      () => undefined,
      (err: unknown) => err,
    );
  }

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('passes a RippleHttpError through, whatever its status', async () => {
    const bad = badRequest('invalid thing');
    expect(await failWith(bad)).toBe(bad);
    const failed = new RippleHttpError(500, 'Another message.');
    expect(await failWith(failed)).toBe(failed);
  });

  it('passes an HttpException below 500 through', async () => {
    const bad = new BadRequestException('nope');
    expect(await failWith(bad)).toBe(bad);
  });

  it.each([
    ['an Error', new Error('secret')],
    ['a rejected string', 'secret'],
    ['a 5xx HttpException', new ServiceUnavailableException('secret')],
  ])('turns %s into a 500 with the route failure message, and logs the cause', async (_name, error) => {
    const result = await failWith(error);
    expect(result).toBeInstanceOf(RippleHttpError);
    expect((result as RippleHttpError).getStatus()).toBe(500);
    expect((result as RippleHttpError).getResponse()).toEqual({
      result: 'error',
      message: 'Could not retrieve thing.',
    });
    expect((Logger.prototype.error as jest.Mock).mock.calls[0][0]).toContain('GET /v2/thing failed');
  });

  describe('a request that failed because the node rate limits this process (ruling R98)', () => {
    let warn: jest.SpyInstance;
    beforeEach(() => {
      resetFailureLog();
      warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    });

    it('is still the 500 of the route, but logged once per pause, at warn and without a stack', async () => {
      const throttled = () =>
        new NodeThrottledError(['wss://node.example'], 60_000, 'rate limit: units quota exhausted, retry in ~59750ms');
      for (let i = 0; i < 3; i++) {
        const result = await failWith(throttled());
        expect(result).toBeInstanceOf(RippleHttpError);
        expect((result as RippleHttpError).getResponse()).toEqual({
          result: 'error',
          message: 'Could not retrieve thing.',
        });
      }
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]).toHaveLength(1); // no stack
      expect(warn.mock.calls[0][0]).toContain('GET /v2/thing failed');
      expect(warn.mock.calls[0][0]).toContain('rate limit');
      expect(Logger.prototype.error).not.toHaveBeenCalled();
      // Any other failure is still an error with its stack.
      await failWith(new Error('boom'));
      expect(Logger.prototype.error).toHaveBeenCalledWith(expect.stringContaining('boom'), expect.any(String));
    });

    it('is logged again once the pause it reported is over', async () => {
      const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
      await failWith(new NodeThrottledError(['wss://node.example'], 5_000, 'rate limit'));
      now.mockReturnValue(1_004_000);
      await failWith(new NodeThrottledError(['wss://node.example'], 5_000, 'rate limit'));
      expect(warn).toHaveBeenCalledTimes(1);
      now.mockReturnValue(1_005_001);
      await failWith(new NodeThrottledError(['wss://node.example'], 5_000, 'rate limit'));
      expect(warn).toHaveBeenCalledTimes(2);
    });
  });
});
