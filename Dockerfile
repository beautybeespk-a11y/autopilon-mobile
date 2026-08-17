# Multi-stage build: server + built client (Phase 18 §44).
#
# NOT BUILD-TESTED IN THIS ENVIRONMENT — no Docker daemon is available in
# this sandbox (confirmed: the docker CLI exists but there is no daemon
# socket to build/run against). This file has been syntax-reviewed and its
# logic matches how server/index.js actually serves the built client
# (server/index.js:231 looks for ../client/dist relative to itself) and how
# server/db.js resolves its database path (DB_PATH env var, Phase 18.7).
# Build and run it for real in any environment with a Docker daemon before
# relying on it for a real deployment — see DEPLOYMENT_RUNBOOK.md.

# ---- Stage 1: build the client -------------------------------------------
FROM node:20-alpine AS client-build
WORKDIR /app/client
COPY client/package*.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

# ---- Stage 2: install server production dependencies ---------------------
FROM node:20-alpine AS server-deps
WORKDIR /app/server
# better-sqlite3 compiles a native binding on install; these are needed to
# build it against Alpine's musl libc if no matching prebuilt binary exists.
RUN apk add --no-cache python3 make g++
COPY server/package*.json ./
RUN npm ci --omit=dev

# ---- Stage 3: final runtime image -----------------------------------------
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=server-deps /app/server/node_modules ./server/node_modules
COPY server/ ./server/
COPY --from=client-build /app/client/dist ./client/dist

# A dedicated, mountable data directory for the SQLite file — see db.js's
# DB_PATH override and BACKUP_RESTORE.md. Without a volume mounted here,
# the database is lost whenever the container is recreated.
RUN mkdir -p /app/data
ENV DB_PATH=/app/data/app.sqlite

WORKDIR /app/server
EXPOSE 4000

# No HEALTHCHECK baked in here deliberately — the orchestrator (Docker
# Compose below, or a real platform's own health-check config) should
# point at GET /api/health/live and /api/health/ready directly, since those
# semantics (liveness vs. readiness) are meaningful to a real orchestrator
# in a way a single Dockerfile HEALTHCHECK directive can't distinguish.
CMD ["node", "index.js"]
