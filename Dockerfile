# syntax=docker/dockerfile:1

# Base image is pinned by digest; Dependabot keeps tag and digest up to date.
FROM oven/bun:1.4.3-alpine@sha256:629e17411f1f129dbec3af78d5af9c9f2a937435c80349437206c6b0b7422373

# git talks to the ShareLaTeX git bridge; tini reaps git's child processes and forwards signals.
# `apk upgrade` pulls security fixes the base image does not have yet (e.g. OpenSSL); package
# versions are deliberately not pinned so every build gets the latest fixes. CI scans the result.
# hadolint ignore=DL3017,DL3018
RUN apk upgrade --no-cache && apk add --no-cache git tini ca-certificates

WORKDIR /app

# The service has no runtime npm dependencies, so there is nothing to install.
COPY package.json ./
COPY src ./src

# BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 keeps bun from writing a cache, so the root filesystem can
# be mounted read-only. /tmp must be writable (tmpfs) for temporary clones and the health file.
ENV NODE_ENV=production \
    BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 \
    WORK_DIR=/tmp \
    HEALTH_FILE=/tmp/zotero-sharelatex-sync.health.json

USER 1000:1000

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD ["bun", "/app/src/index.ts", "healthcheck"]

ENTRYPOINT ["/sbin/tini", "--", "bun", "/app/src/index.ts"]
CMD ["daemon"]
