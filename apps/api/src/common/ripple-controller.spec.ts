import { Get } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
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
