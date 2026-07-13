# syntax=docker/dockerfile:1.7
#
# AgentForge Clinical Co-Pilot — Node 22 sidecar
#
# Two-stage build:
#   1. deps       — install full dependencies (incl. devDeps for tsx)
#   2. runtime    — copy app + node_modules, run with tsx (no compile step)
#
# Designed to drop straight into Railway: PORT is read from $AGENT_SERVICE_PORT
# (default 3000); /healthz is unauthenticated for Railway's HTTP healthcheck.

FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# Use `npm install` rather than `npm ci` so platform-conditional
# optional deps (e.g. @swc/core-linux-x64-musl) resolve correctly on
# Alpine even when the host platform's npm install left them out of
# the committed lockfile.
RUN npm install --no-audit --no-fund

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Create the non-root user up front so subsequent COPYs can set ownership
# inline. A trailing `chown -R agent:agent /app` over the 1k+ packages in
# node_modules dominated build time on Railway; --chown lets Docker set
# perms during the copy itself.
RUN addgroup -S agent && adduser -S agent -G agent

COPY --chown=agent:agent --from=deps /app/node_modules ./node_modules
COPY --chown=agent:agent package.json package-lock.json tsconfig.json ./
COPY --chown=agent:agent src ./src
COPY --chown=agent:agent data ./data

USER agent

EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --retries=4 --start-period=10s \
  CMD wget --quiet --tries=1 --spider "http://127.0.0.1:${AGENT_SERVICE_PORT:-3000}/healthz" || exit 1

CMD ["node_modules/.bin/tsx", "src/server.ts"]
