.PHONY: setup dev test check lint lint-fix format build db-migrate db-generate db-studio clean

# First-time setup
setup:
	bash scripts/setup-dev.sh

# Start dev server with hot reload
dev:
	pnpm dev

# Run unit tests
test:
	pnpm test

# Run e2e tests (requires Docker)
test-e2e:
	pnpm test:e2e

# Full check (lint + typecheck + raw-sql gate)
check:
	pnpm check

# Lint with Biome
lint:
	pnpm lint

# Fix lint issues
lint-fix:
	pnpm lint:fix

# Format with Biome
format:
	pnpm format

# TypeScript build
build:
	pnpm build

# Database migrations
db-migrate:
	pnpm db:migrate

# Database schema generation
db-generate:
	pnpm db:generate

# Browse database in Drizzle Studio
db-studio:
	pnpm db:studio

# Remove build artifacts and data
clean:
	rm -rf dist coverage test-results data
