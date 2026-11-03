# api image - build context MUST be the repo root. The private @gatehub/toolbox needs an npm token at install time, which
# is handed over as a BuildKit secret (mounted for one RUN only, never an ARG/ENV, so it is not in any layer or in
# `docker history`):
#   NPM_TOKEN=... docker build --secret id=npm_token,env=NPM_TOKEN -f apps/api/Dockerfile -t gatehub/data-api .
# docker compose passes it from the NPM_TOKEN environment variable (`build.secrets`, see docker-compose*.yaml).
#
# Public base image (node:22.23.2-bookworm-slim).
#
# Node MUST be >= 20.19 (22.12 on the 22 line): the API's ripple-binary-codec 2.x loads
# ES-module-only dependencies with require(esm), which Node enables by default from those
# versions on. The tag is pinned to an explicit patch version at least two weeks old, the same
# in the api and the syncer image (apps/api/src/node-version.spec.ts checks both). Do not go
# back to a floating tag such as node:20-bookworm-slim; bump all FROM lines together.
FROM node:22.23.2-bookworm-slim AS builder
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.6.3 --activate

# Copy the whole workspace (see .dockerignore: no env files, no .git, no scratch), then install + build in a SINGLE
# RUN. (pnpm's workspace symlinks don't survive across separate RUN layers in BuildKit, so the install and the build
# that depends on them must share one layer.)
#
# The secret is required: without it the build stops here with a clear error instead of failing later on the private
# package. The token goes into ~/.npmrc for the duration of this RUN only; the file is deleted before the layer is
# committed. (The repo's .npmrc keeps its auth line commented out, so that installs without a token do not lose the
# project settings in it; it is read as usual here. NPM_TOKEN is exported as well, for the day that line is enabled.)
COPY . .
RUN --mount=type=secret,id=npm_token,required=true \
  set -eu; \
  test -s /run/secrets/npm_token || { echo "the npm_token secret is empty: pass the npm token of the private @gatehub/toolbox"; exit 1; }; \
  trap 'rm -f "$HOME/.npmrc"' EXIT; \
  NPM_TOKEN="$(cat /run/secrets/npm_token)"; export NPM_TOKEN; \
  printf '//registry.npmjs.org/:_authToken=%s\n' "$NPM_TOKEN" > "$HOME/.npmrc"; \
  pnpm install --frozen-lockfile \
  && pnpm --filter @gatehub/data-api-shared build \
  && pnpm --filter @gatehub/data-api-service build \
  && pnpm --filter @gatehub/data-api-service --legacy deploy --prod /app/out \
  && for f in dist/network/index.js config/markets/xrpl.json config/markets/xahau.json \
    config/markets/xrpl-testnet.json config/markets/xahau-testnet.json \
    config/amendments/xrpl.json config/amendments/xahau.json config/definitions/xrpl.json config/definitions/xahau.json \
    config/definitions/xrpl-testnet.json config/definitions/xahau-testnet.json; do \
    test -f "/app/out/node_modules/@gatehub/data-api-shared/$f" || { echo "missing $f in the deployed shared package"; exit 1; }; \
  done

FROM node:22.23.2-bookworm-slim
WORKDIR /app
# NODE_ENV=production makes the toolbox config loader look for a `.env.production` file and refuse to start without it,
# unless GH_ENV is set to anything: then the configuration comes from the environment only (compose `environment`).
# The API refuses to start in production without GH_API_KEYS, or with a placeholder key (dev-api-key, change-me...).
ENV NODE_ENV=production \
  GH_ENV=container
COPY --from=builder --chown=node:node /app/out/package.json ./package.json
COPY --from=builder --chown=node:node /app/out/dist ./dist
COPY --from=builder --chown=node:node /app/out/node_modules ./node_modules
USER node
# 3001: REST API, /liveliness/healthz and /internal/docs (GH_HTTP_API_PORT)
# 3000: Prometheus metrics, GET /metricz (GH_METRICZ_PORT) - scrape it inside the network, never publish it
EXPOSE 3001 3000
CMD ["node", "dist/main.js"]
