import { NETWORK_NAMES, networkChoiceText } from '@gatehub/data-api-shared/dist/network';
import { ExporterConfig } from './exporter.config';

interface Loaded {
  cfg: ExporterConfig;
  /** Arguments of every `process.exit` call (the toolbox ConfigService exits the process on invalid config). */
  exits: unknown[];
  /** Everything the ConfigService printed with console.error while validating. */
  errors: string;
}

/** The one variable the exporter cannot start without. */
const REQUIRED = { GH_EXPORT_BUCKET: 'exports-test' };

/**
 * Runs the real toolbox ConfigService pipeline (env -> class-transformer -> class-validator) against `env` in an
 * isolated module registry, because the ConfigService keeps its registry in a static field and exits on invalid input.
 */
async function loadConfig(env: Record<string, string> = {}): Promise<Loaded> {
  const saved = { ...process.env };
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('GH_') && key !== 'GH_ENV') delete process.env[key];
  }
  Object.assign(process.env, env);
  const exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    let cfg: ExporterConfig | undefined;
    await jest.isolateModulesAsync(async () => {
      const mod = await import('./exporter.config');
      cfg = await mod.loadExporterConfig();
    });
    return {
      cfg: cfg as unknown as ExporterConfig,
      exits: exit.mock.calls.map((call) => call[0]),
      errors: consoleError.mock.calls.map((call) => call.join(' ')).join('\n'),
    };
  } finally {
    exit.mockRestore();
    consoleError.mockRestore();
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}

describe('ExporterConfig (GH_* environment)', () => {
  it('follows the XRP Ledger when GH_NETWORK is not set', async () => {
    const { cfg, exits } = await loadConfig(REQUIRED);
    expect(exits).toEqual([]);
    expect(cfg.network).toBe('xrpl');
  });

  it.each(NETWORK_NAMES)('takes GH_NETWORK=%s', async (name) => {
    const { cfg, exits } = await loadConfig({ ...REQUIRED, GH_NETWORK: name });
    expect(exits).toEqual([]);
    expect(cfg.network).toBe(name);
  });

  it('refuses another network, listing the four', async () => {
    const { exits, errors } = await loadConfig({ ...REQUIRED, GH_NETWORK: 'bitcoin' });
    expect(exits).toEqual([1]);
    expect(errors).toContain(networkChoiceText('GH_NETWORK'));
    expect(errors).toContain('GH_NETWORK must be one of xrpl, xahau, xrpl-testnet, xahau-testnet');
  });
});
