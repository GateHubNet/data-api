import { AmmPairController } from './amm-pools.controller';
import { AmmModule } from './amm.module';

describe('AmmModule', () => {
  // Express matches routes in the order they are registered, and Nest registers the controllers of a module in the order of
  // `controllers`. `/v2/amm/pools/:base/:counter` (the pair form) matches every path with two segments after `pools`, so a
  // route such as `/v2/amm/pools/:pool/history` or `/:pool/swaps` registered after it would be read as the pair `rPool` /
  // `history`. The pair form therefore has to be the last of all.
  it('registers the pair form last, so that no `/pools/:pool/<something>` route is taken for a pair', () => {
    const controllers = Reflect.getMetadata('controllers', AmmModule) as unknown[];
    expect(controllers.length).toBeGreaterThanOrEqual(2);
    expect(controllers[controllers.length - 1]).toBe(AmmPairController);
    expect(controllers.filter((c) => c === AmmPairController)).toHaveLength(1);
  });
});
