# ---------------------------------------------------------------------------
# wopr-node-agent: Lightweight container daemon for worker nodes
# Target: < 100MB final image
# ---------------------------------------------------------------------------

# Stage 1: Install production dependencies
FROM node:24-alpine AS deps

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Stage 2: Build TypeScript
FROM node:24-alpine AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Stage 3: Runtime
FROM node:24-alpine AS runtime

# s3cmd for backup uploads to DO Spaces
RUN apk add --no-cache s3cmd

WORKDIR /app

RUN addgroup -S wopr && adduser -S wopr -G wopr

# Production node_modules
COPY --from=deps /app/node_modules ./node_modules

# Compiled output
COPY --from=build /app/dist ./dist

# Package manifest (needed by Node for ESM resolution)
COPY package.json ./

# Backup directory
RUN mkdir -p /backups && chown wopr:wopr /backups
VOLUME /backups

# Ownership
RUN chown -R wopr:wopr /app

USER wopr

ENV NODE_ENV=production

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e 'process.exit(0)'

CMD ["node", "dist/node-agent/index.js"]
