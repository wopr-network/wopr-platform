#!/usr/bin/env bash
set -euo pipefail

echo "=== WOPR Platform — Local Dev Setup ==="

# 1. Check prerequisites
echo ""
echo "Checking prerequisites..."

check_cmd() {
  if ! command -v "$1" &>/dev/null; then
    echo "ERROR: $1 is required but not installed."
    echo "  Install: $2"
    exit 1
  fi
  echo "  OK: $1 ($($1 --version 2>/dev/null | head -1))"
}

check_cmd node "https://nodejs.org (v24+)"
check_cmd pnpm "corepack enable && corepack prepare pnpm@latest --activate"
check_cmd python3 "apt install python3 / brew install python3 (needed for better-sqlite3)"

# Check Node version >= 24
NODE_MAJOR=$(node -e "console.log(process.versions.node.split('.')[0])")
if [ "$NODE_MAJOR" -lt 24 ]; then
  echo "ERROR: Node.js 24+ required (found v$NODE_MAJOR)"
  exit 1
fi

# 2. Install dependencies
echo ""
echo "Installing dependencies..."
pnpm install

# 3. Copy env if not exists
if [ ! -f .env ]; then
  echo ""
  echo "Creating .env from .env.dev..."
  cp .env.dev .env
else
  echo ""
  echo ".env already exists — skipping copy."
fi

# 4. Create data directories
echo ""
echo "Creating data directories..."
mkdir -p data/platform

# 5. Run database migrations
echo ""
echo "Running database migrations..."
pnpm db:migrate

# 6. Verify build
echo ""
echo "Verifying TypeScript build..."
pnpm build

# 7. Run tests
echo ""
echo "Running tests to verify setup..."
pnpm test

echo ""
echo "=== Setup complete! ==="
echo ""
echo "Start the dev server:  pnpm dev"
echo "Run tests:             pnpm test"
echo "Check code:            pnpm check"
echo "API available at:      http://localhost:3100"
echo "Health check:          http://localhost:3100/health"
