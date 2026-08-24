FROM node:22-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src/ ./src/
# Server only — the admin console UI is deliberately not shipped. See below.
RUN pnpm run build:server

FROM node:22-slim
WORKDIR /app
ARG DISPATCHER_VERSION=unknown
ARG DISPATCHER_GIT_SHA=unknown
ARG DISPATCHER_BUILD_TIME=unknown
ARG DISPATCHER_IMAGE_TAG=unknown
ENV DISPATCHER_VERSION=${DISPATCHER_VERSION}
ENV DISPATCHER_GIT_SHA=${DISPATCHER_GIT_SHA}
ENV DISPATCHER_BUILD_TIME=${DISPATCHER_BUILD_TIME}
ENV DISPATCHER_IMAGE_TAG=${DISPATCHER_IMAGE_TAG}
# Links the GHCR package to this repository: the package page shows the repo and
# README, and package permissions can inherit from it. Without this label the
# published package is an orphan in the org's package list.
LABEL org.opencontainers.image.source="https://github.com/Scale-Margins-V0/dispatcher-package-internal"
LABEL org.opencontainers.image.description="ScaleMargin Dispatcher — self-hosted campaign dispatch service"
LABEL org.opencontainers.image.licenses="UNLICENSED"
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod
COPY --from=build /app/dist ./dist
# admin-dist is intentionally absent: the client-facing image ships no console
# UI. src/admin/routes.ts detects the missing directory and serves 503 on
# /admin, while /admin/api/* stays mounted. Management happens through the
# Atlas data-plane API (/api/v1/data-plane/*).
# State-DB migrations must ship with the app — the startup migrator reads them.
COPY drizzle/ ./drizzle/
RUN mkdir -p /app/data
ENV NODE_ENV=production
EXPOSE 3100
# node:22-slim has no curl; probe via Node's fetch
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://localhost:3100/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
