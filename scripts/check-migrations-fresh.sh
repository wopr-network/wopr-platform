#!/usr/bin/env bash
# scripts/check-migrations-fresh.sh
# Ensures drizzle-kit generate produces no new migration files.
# If a developer changes src/db/schema/ without running pnpm db:generate,
# this gate catches it.
set -euo pipefail

MIGRATIONS_DIR="./drizzle/migrations"

# Count existing migration files
before=$(find "$MIGRATIONS_DIR" -maxdepth 1 -name '*.sql' | wc -l)

# Run generate (produces new .sql file if schema diverged)
pnpm db:generate 2>&1

# Count after
after=$(find "$MIGRATIONS_DIR" -maxdepth 1 -name '*.sql' | wc -l)

if [ "$after" -gt "$before" ]; then
  echo "ERROR: Schema changes detected without a committed migration."
  echo "Run 'pnpm db:generate' and commit the new migration file."
  # Clean up the generated file so git diff is clean
  git checkout -- "$MIGRATIONS_DIR" || true
  exit 1
fi

echo "OK: Migrations are up to date with schema."
