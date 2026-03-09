# wopr-platform

Backend API server for wopr.network — fleet management, billing, instance orchestration, auth, and the gateway layer between the SaaS platform and customer WOPR instances.

## Commands

```bash
npm run build          # tsc
npm run dev            # tsx src/index.ts
npm run check          # biome check + tsc --noEmit (run before committing)
npm run lint:fix       # biome check --fix src/
npm run format         # biome format --write src/
npm test               # vitest run
npm run test:e2e       # vitest run --config vitest.config.e2e.ts
npm run test:coverage  # vitest run --coverage
npm run db:generate    # drizzle-kit generate (after schema changes)
npm run db:migrate     # drizzle-kit migrate (apply migrations)
npm run db:studio      # drizzle-kit studio (browse database)
```

**Always run `db:generate` then `db:migrate` after changing `src/db/schema/`.**

## Architecture

```
src/
  index.ts          # Entry point — starts HTTP server
  api/
    app.ts          # Hono app setup
    routes/         # API route handlers
    middleware/     # Auth, rate limiting, logging middleware
  auth/             # Authentication (sessions, OAuth, API keys)
  db/
    index.ts        # Drizzle ORM client
    schema/         # Table definitions (source of truth for migrations)
  fleet/            # Multi-bot fleet management
  gateway/          # Proxy layer between platform and customer instances
  monetization/     # Credits, subscriptions, usage tracking
  network/          # Networking / connectivity to customer instances
  node-agent/       # Agent running on customer hardware
  observability/    # Metrics, logging, tracing
  security/         # Input validation, rate limiting, audit logging
  admin/            # Internal admin APIs
  backup/           # Backup and restore
  dht/              # DHT bootstrap node support
  discovery/        # Instance discovery
  email/            # Transactional email
  trpc/             # tRPC router (consumed by wopr-platform-ui)
```

## Key Libraries

- **Hono** — HTTP server (same as wopr core daemon)
- **Drizzle ORM** — type-safe SQL (PostgreSQL)
- **tRPC** — type-safe API layer consumed by `wopr-platform-ui`
- **Biome** — linting/formatting (not ESLint/Prettier)

## Deployment

- `docker-compose.yml` — production stack
- `docker-compose.staging.yml` — staging
- `docker-compose.gpu.yml` — GPU-enabled (for local Whisper/Piper)
- `Caddyfile` — reverse proxy config (HTTPS termination)
- **Migrations must be applied before deploying new code** — `db:migrate` first

## Issue Tracking

All issues in **Linear** (team: WOPR). Issue descriptions start with `**Repo:** wopr-network/wopr-platform`.

## Session Memory

At the start of every WOPR session, **read `~/.wopr-memory.md` if it exists.** It contains recent session context: which repos were active, what branches are in flight, and how many uncommitted changes exist. Use it to orient quickly without re-investigating.

The `Stop` hook writes to this file automatically at session end. Only non-main branches are recorded — if everything is on `main`, nothing is written for that repo.

## Architectural Patterns

### Repository Pattern (Mandatory)

All database access MUST go through repository interfaces. Direct Drizzle ORM or better-sqlite3 usage is forbidden outside approved files.

**Approved files:**
- `src/db/**` — schema definitions, Drizzle client, pragmas
- `src/fleet/*-repository.ts` — DrizzleXxxRepository implementations
- `src/fleet/registration-token-store.ts` — Drizzle-based token store
- `src/fleet/services.ts` — singleton wiring, creates DB and repos
- `src/test/**` — test helpers
- `**/*.test.ts` — test files

**Enforcement (run `npm run check` to invoke all gates):**

**Gate 1 — Import Restriction (Biome `noRestrictedImports`):** `drizzle-orm` and `better-sqlite3` imports are banned outside the approved files above. Any violation fails `pnpm lint`. The error message references this section.

**Gate 2 — Raw SQL Pattern Ban (`scripts/check-raw-sql.sh`):** `.prepare()` and `.exec()` calls are banned outside approved files. Even inside repository files, prefer Drizzle query builders (`db.select()`, `db.insert()`, `db.update()`, `db.delete()`). Raw `.prepare()` is a last resort and requires a comment: `// raw SQL: Drizzle cannot express <reason>`.

**Adding a new repository:** Create `src/<domain>/drizzle-<name>-repository.ts` implementing `I<Name>Repository`. Add it to the biome.json overrides approved section. Wire it in `src/fleet/services.ts`.

## Gotchas

- **Fake time in tests**: Capture `baseNow` before `vi.useFakeTimers()`, then use `baseNow + offsetMs` for all `setSystemTime()` calls to avoid non-deterministic behavior.
- **Test IDs**: Use `crypto.randomUUID()` instead of `Date.now()` to prevent ID collision failures in parallel test runs.
- **Cleanup on failure**: Always place watchers/intervals/timers in a `finally` block to guarantee cleanup even if assertions fail.
- **SSE event filtering**: Never use a single `tenantId` guard for all SSE events. Branch on event type — tenant-scoped events filter by tenantId, system-wide events (e.g. NodeFleetEvents) forward to all authenticated subscribers.
- **WAL append ordering**: Write-ahead log append must happen *before* the in-memory buffer push — fail-closed ordering ensures durability before visibility.
- **WAL append must be synchronous**: Use `appendFileSync` (POSIX O_APPEND is atomic per-write) — making it async breaks the fail-closed durability guarantee.
- **Read-filter-rewrite needs a mutex**: Any operation that reads a file, filters lines, then rewrites has a TOCTOU race; guard with a mutex. Append-only operations using O_APPEND do not.
- **e2e async assertions**: In Playwright e2e tests, always `await` async state changes (e.g. resolution events) before asserting visibility — bare `expect(getByText(...)).toBeVisible()` races against pending UI updates.
- **Cooldown timestamps on failure**: In autoscaler (and any rate-limited retry loop), record cooldown timestamps inside `catch` blocks too — if the operation throws, the cooldown must still be set to prevent retry storms.
- **Isolate audit/notifier from main ops**: Audit log writes and notifier calls must have their own try/catch, separate from the main operation — a logging failure must never mask or prevent the primary error from propagating.
- **Drizzle migration separators**: Every SQL statement in a migration file must be followed by a `--> statement-breakpoint` comment — PGlite (used in unit tests) runs each segment as a single prepared statement and rejects multiple commands without separators.
- **e2e mock reset**: Use `vi.resetAllMocks()` in `beforeEach`, not `vi.clearAllMocks()` — `clearAllMocks` only clears call history while `resetAllMocks` also resets implementations and return values.
- **e2e env stub cleanup**: Always add `afterAll(() => { vi.unstubAllEnvs(); })` in test files that use `vi.stubEnv()` — otherwise stubbed env vars leak into other test files in the same process.