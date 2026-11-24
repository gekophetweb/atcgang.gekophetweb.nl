# syntax=docker/dockerfile:1.7
FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN npm install -g corepack@latest && corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm build

FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --prod

FROM node:22-slim AS runtime
ENV NODE_ENV=production PORT=3000 PHOTO_DIR=/data/photos CLIENT_DIR=/app/dist/client
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl \
  && apt-get clean \
  && mkdir -p /data/photos && chown -R node:node /data
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node drizzle ./drizzle
COPY --chown=node:node package.json ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD curl -fsS http://localhost:3000/healthz || exit 1
CMD ["node", "--enable-source-maps", "dist/server/index.js"]
