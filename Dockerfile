# ---------------------------------------------------------------------------
# Stage 1: Install production dependencies
# ---------------------------------------------------------------------------
FROM node:25-alpine AS deps

# better-sqlite3 requires native compilation toolchain on Alpine
RUN apk add --no-cache python3 make g++

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---------------------------------------------------------------------------
# Stage 2: Build TypeScript
# ---------------------------------------------------------------------------
FROM node:25-alpine AS build

WORKDIR /app

# Full node_modules (including devDeps) needed for tsc
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ---------------------------------------------------------------------------
# Stage 3: Runtime
# ---------------------------------------------------------------------------
FROM node:25-alpine AS runtime

# curl for HEALTHCHECK
RUN apk add --no-cache curl

WORKDIR /app

RUN addgroup -S wopr && adduser -S wopr -G wopr

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
