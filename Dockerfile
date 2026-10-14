# syntax=docker/dockerfile:1

# Base image is pinned by digest; Dependabot keeps tag and digest up to date.
FROM oven/bun:1.3.14-alpine@sha256:5acc90a93e91ff07bf72aa90a7c9f0fa189765aec90b47bdbf2152d2196383c0

# git talks to the ShareLaTeX git bridge; tini reaps git's child processes and forwards signals.
# Alpine package versions are not pinned on purpose: we want the latest security fixes.
# hadolint ignore=DL3018
RUN apk add --no-cache git tini ca-certificates

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
