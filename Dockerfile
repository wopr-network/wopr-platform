# ---------------------------------------------------------------------------
# Stage 1: Install production dependencies
# ---------------------------------------------------------------------------
FROM node:24-bookworm-slim AS deps

# better-sqlite3 requires native compilation toolchain
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10 --activate

WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

# ---------------------------------------------------------------------------
# Stage 2: Build TypeScript
# ---------------------------------------------------------------------------
FROM node:24-bookworm-slim AS build

RUN corepack enable && corepack prepare pnpm@10 --activate

WORKDIR /app

# Full node_modules (including devDeps) needed for tsc
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src/ ./src/
RUN pnpm build

# ---------------------------------------------------------------------------
# Stage 3: Runtime
# ---------------------------------------------------------------------------
FROM node:24-bookworm-slim AS runtime

# curl for HEALTHCHECK
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN groupadd wopr && useradd -g wopr -m wopr

# Production node_modules (with native better-sqlite3 already compiled)
COPY --chown=wopr:wopr --from=deps /app/node_modules ./node_modules

# Compiled output
COPY --chown=wopr:wopr --from=build /app/dist ./dist

# Migration SQL files for drizzle-orm migrator
COPY --chown=wopr:wopr drizzle/migrations/ ./drizzle/migrations/

# Package manifest (needed by Node for ESM resolution)
COPY --chown=wopr:wopr package.json ./

# Profile templates loaded at runtime by fleet module
COPY --chown=wopr:wopr templates/ ./templates/

# Migration files for schema versioning
COPY --chown=wopr:wopr drizzle/ ./drizzle/

USER wopr

ENV NODE_ENV=production
ENV PORT=3100

EXPOSE 3100

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:${PORT}/health || exit 1

CMD ["node", "dist/index.js"]
