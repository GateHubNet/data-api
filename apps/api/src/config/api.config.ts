import { Global, Logger, Module } from '@nestjs/common';

export interface ApiConfig {
  port: number;
  corsOrigins: string[];
  rateLimit: number;
  rateLimitWindow: number;
  xrplEndpoint: string;
  /** Accepted API keys. Empty array = auth disabled (dev only). */
  apiKeys: string[];
  /** TTL (ms) for cached live-XRPL responses (balances/orders). 0 disables caching. */
  liveCacheTtlMs: number;
  /** Number of reverse-proxy hops to trust for X-Forwarded-For (Express `trust proxy`). */
  trustProxyHops: number;
}

class ConfigError extends Error {}

function requirePositive(name: string, raw: string | undefined, fallback?: number): number {
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  if (value === undefined || Number.isNaN(value) || value < 0) {
    throw new ConfigError(`Invalid or missing numeric config ${name}: ${String(raw)}`);
  }
  return value;
}

/**
 * Builds and validates the API config from the environment, failing fast on bad input.
 * In production these env vars are expected to be injected from a secrets manager
 * (Vault / AWS Secrets Manager / k8s secrets) — never committed. See README.
 */
export function apiConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const apiKeys = (env.GH_API_KEYS ?? '')
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);

  if (apiKeys.length === 0 && env.NODE_ENV === 'production') {
    // Don't hard-fail (allows a deliberately public deployment) but make it loud.
    new Logger('ApiConfig').warn('GH_API_KEYS is empty in production — the API is UNAUTHENTICATED.');
  }

  return {
    port: requirePositive('GH_HTTP_API_PORT', env.GH_HTTP_API_PORT, 3001),
    corsOrigins: (env.GH_CORS_ORIGINS ?? '')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
    rateLimit: requirePositive('GH_RATE_LIMIT', env.GH_RATE_LIMIT, 600),
    rateLimitWindow: requirePositive('GH_RATE_LIMIT_WINDOW', env.GH_RATE_LIMIT_WINDOW, 60),
    xrplEndpoint: env.GH_XRPL_NODE_ENDPOINT ?? 'wss://xrplcluster.com',
    apiKeys,
    liveCacheTtlMs: requirePositive('GH_LIVE_CACHE_TTL_MS', env.GH_LIVE_CACHE_TTL_MS, 10_000),
    trustProxyHops: requirePositive('GH_TRUST_PROXY_HOPS', env.GH_TRUST_PROXY_HOPS, 1),
  };
}

export const API_CONFIG = Symbol('API_CONFIG');

@Global()
@Module({
  providers: [{ provide: API_CONFIG, useFactory: () => apiConfigFromEnv() }],
  exports: [API_CONFIG],
})
export class ConfigModule {}
