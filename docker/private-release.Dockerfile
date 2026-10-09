# syntax=docker/dockerfile:1
FROM --platform=$BUILDPLATFORM oven/bun:1.4.2 AS bun-native
FROM --platform=$BUILDPLATFORM node:24-bookworm AS compile
COPY --from=bun-native /usr/local/bin/bun /usr/local/bin/bun
ENV NODE_OPTIONS=--max-old-space-size=8192 OPENBOT_SKIP_SKIA=1 WRANGLER_SEND_METRICS=false
WORKDIR /src
COPY . .
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --frozen-lockfile
RUN bun run i18n:check && bun run typecheck:node && bun run typecheck:renderer && bun run typecheck:api
RUN bun run build && bun run verify:preload
ARG PRIVATE_CONFIG_SHA
RUN --mount=type=secret,id=private_wrangler,required=true \
    test -n "$PRIVATE_CONFIG_SHA" && cp /run/secrets/private_wrangler apps/auth-api/wrangler.jsonc && bun run api:build

# Only dependency installation and packaging use amd64 emulation on an ARM Mac.
# The large JavaScript builds above run on the computer's native architecture.
FROM oven/bun:1.4.2 AS bun-amd64
FROM node:24-bookworm AS package
COPY --from=bun-amd64 /usr/local/bin/bun /usr/local/bin/bun
ENV NODE_OPTIONS=--max-old-space-size=8192 OPENBOT_SKIP_SKIA=1
WORKDIR /src
COPY . .
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --frozen-lockfile
COPY --from=compile /src/out /src/out
RUN node node_modules/electron-builder/cli.js --linux dir --x64 --publish never \
    && chmod -R u+rwX,go=rX dist/linux-unpacked

FROM ghcr.io/nightly-labs/openbot:0.33.0@sha256:b9290c58f1f2b9a20a04657398e8c313999b23e3231adc60a96c15d6e8f6aaa7 AS runtime
USER root
RUN apt-get update && apt-get install -y --no-install-recommends bubblewrap nodejs python3 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=package /src/dist/linux-unpacked/ /opt/OpenBot/app/
ARG REVISION
LABEL org.opencontainers.image.source=https://github.com/xztyle/openbot \
      org.opencontainers.image.revision=$REVISION
USER openbot

FROM scratch AS website
COPY --from=compile /src/apps/auth-api/dist/ /dist/
COPY --from=compile /src/apps/auth-api/migrations/ /migrations/
