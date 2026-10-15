# api image — build context MUST be the repo root:
#   docker build -f apps/api/Dockerfile -t gatehub/data-api .
#
# Public base image (node:22.23.2-bookworm-slim). NPM_TOKEN is only needed at build time
# to install the private @gatehub/toolbox.
#
# Node MUST be >= 20.19 (22.12 on the 22 line): the API's ripple-binary-codec 2.x loads
# ES-module-only dependencies with require(esm), which Node enables by default from those
# versions on. The tag is pinned to an explicit patch version at least two weeks old, the same
# in the api and the syncer image (apps/api/src/node-version.spec.ts checks both). Do not go
# back to a floating tag such as node:20-bookworm-slim; bump all FROM lines together.
FROM node:22.23.2-bookworm-slim AS builder
WORKDIR /app

ARG NPM_TOKEN
ENV npm_read_token=$NPM_TOKEN
RUN corepack enable && corepack prepare pnpm@10.6.3 --activate
RUN npm config set "//registry.npmjs.org/:_authToken" "${npm_read_token}"

# Copy the whole workspace, then install + build in a SINGLE RUN. (pnpm's workspace
# symlinks don't survive across separate RUN layers in BuildKit, so the install and
# the build that depends on them must share one layer.)
COPY . .
RUN pnpm install \
  && pnpm --filter @gatehub/data-api-shared build \
  && pnpm --filter @gatehub/data-api-service build \
  && pnpm --filter @gatehub/data-api-service --legacy deploy --prod /app/out

FROM node:22.23.2-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder --chown=node:node /app/out ./
USER node
EXPOSE 3001
CMD ["node", "dist/main.js"]
