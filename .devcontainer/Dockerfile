FROM mcr.microsoft.com/devcontainers/javascript-node:24

# better-sqlite3 native compilation dependencies
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

# Install pnpm globally
RUN corepack enable && corepack prepare pnpm@latest --activate
