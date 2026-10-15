import { NetworkProfile } from '@gatehub/data-api-shared';
import { Get, Inject, Query } from '@nestjs/common';
import { RippledError } from 'xrpl';
import { BinaryCodecService } from '../src/common/binary-codec.service';
import { RippleController } from '../src/common/ripple-controller';
import { NETWORK_PROFILE } from '../src/config/api.config';
import { XrplService } from '../src/xrpl/xrpl.service';

/**
 * Routes that show what the harness did to the app it built (`harness.e2e-spec.ts`). Like `test-controllers.ts` this
 * file is imported through the `controllers` callback, so that its classes (`XrplService`, `RippledError`) come from
 * the same module registry as the AppModule.
 */
@RippleController('v2/harness')
export class HarnessController {
  constructor(
    private readonly xrpl: XrplService,
    private readonly codec: BinaryCodecService,
    @Inject(NETWORK_PROFILE) private readonly profile: NetworkProfile,
  ) {}

  /** The network the app runs for and where its binary codec got its definitions from. */
  @Get('network')
  network(): Record<string, unknown> {
    return {
      result: 'success',
      network: this.profile.name,
      native: this.profile.nativeCurrency,
      definitions: this.codec.definitionsSource,
    };
  }

  /** Sends `?command=` through the `XrplService` of the app (the stub of the harness) and reports how it ended. */
  @Get('node')
  async node(@Query('command') command: string): Promise<Record<string, unknown>> {
    try {
      return { result: 'success', node: await this.xrpl.request({ command }) };
    } catch (err) {
      const error = err as Error & { data?: unknown };
      return {
        result: 'failed',
        isRippledError: err instanceof RippledError,
        name: error.name,
        message: error.message,
        data: error.data,
      };
    }
  }
}

export const HARNESS_CONTROLLERS = [HarnessController];
