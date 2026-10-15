# syncer image — build context MUST be the repo root:
#   docker build -f apps/syncer/Dockerfile -t gatehub/data-syncer .
#
# Public base image (node:20-bookworm-slim). NPM_TOKEN is only needed at build time
# to install the private @gatehub/toolbox.
FROM node:20-bookworm-slim AS builder
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
  && pnpm --filter @gatehub/data-syncer build \
  && pnpm --filter @gatehub/data-syncer --legacy deploy --prod /app/out

FROM node:20-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder --chown=node:node /app/out ./
# schema/ ships with the shared package so the syncer can run migrations on boot.
USER node
EXPOSE 3002
CMD ["node", "dist/main.js"]
