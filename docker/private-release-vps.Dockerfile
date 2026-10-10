# syntax=docker/dockerfile:1
# The private release image, built on the VPS (linux/amd64 only), arranged so a small change rebuilds
# only what it touches. Each stage copies only the files it reads, from a named build context that
# build-vps.sh prepares:
#   deps-src     manifests, lockfile, patches and the install lifecycle scripts -> `bun install` layer
#   website-src  what the Cloudflare Worker and its website read              -> `api:build` layer
#   app-src      the whole checkout (Tailwind scans every file for class names)  -> `bun run build` layer
#   package-src  what electron-builder packages besides `out/` and node_modules -> packaging layer
#   full-src     the whole checkout, only for the `checks` target
# Targets: runtime (the image), website (the Worker files), checks (typechecks, run on request).
FROM oven/bun:1.4.2 AS bun-bin
FROM node:24-bookworm AS toolchain
COPY --from=bun-bin /usr/local/bin/bun /usr/local/bin/bun
ENV NODE_OPTIONS=--max-old-space-size=8192 OPENBOT_SKIP_SKIA=1 WRANGLER_SEND_METRICS=false
WORKDIR /src

# Changes only when a dependency, a patch or an install script changes.
FROM toolchain AS install
COPY --from=deps-src . .
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --frozen-lockfile

# The Worker and website. Unchanged website inputs and wrangler.jsonc make this a cache hit.
FROM install AS website-build
COPY --from=website-src . .
ARG PRIVATE_CONFIG_SHA
RUN --mount=type=secret,id=private_wrangler,required=true \
    test -n "$PRIVATE_CONFIG_SHA" && cp /run/secrets/private_wrangler apps/auth-api/wrangler.jsonc && bun run api:build

FROM scratch AS website
COPY --from=website-build /src/apps/auth-api/dist/ /dist/
COPY --from=website-build /src/apps/auth-api/migrations/ /migrations/

# The desktop app bundle.
FROM install AS app-build
COPY --from=app-src . .
RUN bun run build && bun run verify:preload

# The Linux package: the bundle, the installed modules and the files electron-builder lists.
FROM install AS package
COPY --from=package-src . .
COPY --from=app-build /src/out /src/out
RUN node node_modules/electron-builder/cli.js --linux dir --x64 --publish never \
    && chmod -R u+rwX,go=rX dist/linux-unpacked

# Typechecks and the translation check. Not part of the image: only built with --target checks.
FROM install AS checks
COPY --from=full-src . .
RUN bun run i18n:check && bun run typecheck:node && bun run typecheck:renderer && bun run typecheck:api

FROM ghcr.io/nightly-labs/openbot:0.33.0@sha256:b9290c58f1f2b9a20a04657398e8c313999b23e3231adc60a96c15d6e8f6aaa7 AS runtime
USER root
RUN apt-get update && apt-get install -y --no-install-recommends bubblewrap nodejs python3 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=package /src/dist/linux-unpacked/ /opt/OpenBot/app/
ARG REVISION
LABEL org.opencontainers.image.source=https://github.com/xztyle/openbot \
      org.opencontainers.image.revision=$REVISION
USER openbot
