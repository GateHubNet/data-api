import { NotFoundModule } from './common/not-found.controller';
import { ValidatorsModule } from './validators/validators.module';

describe('AppModule', () => {
  // The module reads GH_* when it is imported; the defaults are enough here.
  it('imports the /v2 catch-all last, so that it cannot shadow an endpoint module', async () => {
    const { AppModule } = await import('./app.module');
    const imports = Reflect.getMetadata('imports', AppModule) as unknown[];
    expect(imports.length).toBeGreaterThan(1);
    expect(imports[imports.length - 1]).toBe(NotFoundModule);
    expect(imports.filter((m) => m === NotFoundModule)).toHaveLength(1);
  });

  it('serves the validators routes: the module is an endpoint module, before the catch-all', async () => {
    const { AppModule } = await import('./app.module');
    const imports = Reflect.getMetadata('imports', AppModule) as unknown[];
    expect(imports.filter((m) => m === ValidatorsModule)).toHaveLength(1);
    expect(imports.indexOf(ValidatorsModule)).toBeLessThan(imports.indexOf(NotFoundModule));
  });
});
