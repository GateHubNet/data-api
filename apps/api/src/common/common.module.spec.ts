import { getNetworkProfile } from '@gatehub/data-api-shared';
import { DynamicModule } from '@nestjs/common';
import { ApiConfig } from '../config/api.config';
import { XrplModule } from '../xrpl/xrpl.module';
import { XrplService } from '../xrpl/xrpl.service';
import { BinaryCodecService } from './binary-codec.service';
import { CommonModule } from './common.module';
import { LedgerRangeResolver } from './ledger-range.service';
import { TxService } from './tx-object';

function register(): DynamicModule {
  const profile = getNetworkProfile('xrpl');
  return CommonModule.register({
    config: new ApiConfig(),
    profile,
    clickHouse: { url: 'http://localhost:8123' } as never,
  });
}

describe('CommonModule', () => {
  it('provides and exports the shared services of the endpoint modules', () => {
    const mod = register();
    for (const provider of [LedgerRangeResolver, TxService, BinaryCodecService]) {
      expect(mod.providers).toContain(provider);
      expect(mod.exports).toContain(provider);
    }
    expect(Reflect.getMetadata('__module:global__', CommonModule)).toBe(true);
  });
});

describe('XrplModule', () => {
  it('is global and provides and exports the XrplService', () => {
    expect(Reflect.getMetadata('__module:global__', XrplModule)).toBe(true);
    expect(Reflect.getMetadata('providers', XrplModule)).toContain(XrplService);
    expect(Reflect.getMetadata('exports', XrplModule)).toContain(XrplService);
  });
});
