FROM node:22-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json vite.config.ts ./
COPY src/ ./src/
COPY admin/ ./admin/
RUN pnpm run build

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
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod
COPY --from=build /app/dist ./dist
COPY --from=build /app/admin-dist ./admin-dist
ENV NODE_ENV=production
EXPOSE 3100
HEALTHCHECK --interval=30s --timeout=3s CMD curl -f http://localhost:3100/health || exit 1
CMD ["node", "dist/index.js"]
