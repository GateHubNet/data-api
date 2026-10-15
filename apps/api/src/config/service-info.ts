import { BootstrapConfig } from '@gatehub/toolbox/lib/bootstrap';
import { GateHubConfigModule } from '@gatehub/toolbox/lib/config/config.module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The `version` of this package's `package.json` (`src/config` and `dist/config` are both two levels below it). */
function packageVersion(): string {
  try {
    const manifest = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
      version?: string;
    };
    return manifest.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * The toolbox `bootstrap()` titles its swagger document with `BootstrapConfig` (`GH_SERVICE_NAME`,
 * `GH_SERVICE_DESCRIPTION`, `GH_SERVICE_VERSION`), which only `GateHubBootstrapModule` registers, and that module also
 * installs the toolbox's security-context middleware. Register the configuration alone, with defaults for what the
 * environment leaves out (call it after `loadApiConfig()`: that is what loads the env file).
 */
export async function registerServiceInfo(): Promise<void> {
  process.env.GH_SERVICE_NAME ||= 'data-api';
  process.env.GH_SERVICE_DESCRIPTION ||=
    'Ripple Data API v2 compatible API for XRPL and Xahau, served from ClickHouse.';
  process.env.GH_SERVICE_VERSION ||= packageVersion();
  await GateHubConfigModule.forFeature(BootstrapConfig);
}
