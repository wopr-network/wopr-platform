/**
 * MIGRATION CONVENTIONS (WOP-526)
 *
 * SQLite limitations for zero-downtime deploys:
 *
 * SAFE operations (backward-compatible, can run while old code serves traffic):
 *   - CREATE TABLE
 *   - ADD COLUMN (with DEFAULT or nullable)
 *   - CREATE INDEX
 *
 * UNSAFE operations (require expand-contract pattern):
 *   - DROP TABLE    → rename to _deprecated_X first, drop in a later release
 *   - DROP COLUMN   → stop reading it first, drop in a later release
 *   - RENAME COLUMN → add new column, backfill, update code, drop old in next release
 *   - NOT NULL on existing column → add with DEFAULT, backfill, then add constraint
 *
 * Every migration MUST be backward-compatible with the PREVIOUS release's code.
 * The deploy sequence is: migrate DB -> roll out new code. If the new code crashes,
 * the old code must still work with the migrated schema.
 *
 * Drizzle-kit generates migrations from schema diffs. After changing src/db/schema/,
 * run `pnpm db:generate` and review the generated SQL before committing.
 */
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: [
    "./src/db/schema/admin-audit.ts",
    "./src/db/schema/admin-notes.ts",
    "./src/db/schema/admin-users.ts",
    "./src/db/schema/bulk-undo-grants.ts",
    "./src/db/schema/audit.ts",
    "./src/db/schema/bot-instances.ts",
    "./src/db/schema/bot-profiles.ts",
    "./src/db/schema/credit-auto-topup.ts",
    "./src/db/schema/credit-auto-topup-settings.ts",
    "./src/db/schema/credits.ts",
    "./src/db/schema/email-notifications.ts",
    "./src/db/schema/gpu-nodes.ts",
    "./src/db/schema/meter-events.ts",
    "./src/db/schema/node-registration-tokens.ts",
    "./src/db/schema/node-transitions.ts",
    "./src/db/schema/nodes.ts",
    "./src/db/schema/notification-queue.ts",
    "./src/db/schema/provider-credentials.ts",
    "./src/db/schema/rates.ts",
    "./src/db/schema/recovery-events.ts",
    "./src/db/schema/security-settings.ts",
    "./src/db/schema/restore-log.ts",
    "./src/db/schema/snapshots.ts",
    "./src/db/schema/stripe.ts",
    "./src/db/schema/tenant-status.ts",
    "./src/db/schema/spending-limits.ts",
    "./src/db/schema/user-roles.ts",
    "./src/db/schema/affiliate.ts",
    "./src/db/schema/dividend-distributions.ts",
    "./src/db/schema/oauth-states.ts",
    "./src/db/schema/webhook-sig-penalties.ts",
    "./src/db/schema/webhook-seen-events.ts",
    "./src/db/schema/sessions.ts",
    "./src/db/schema/provider-health-overrides.ts",
    "./src/db/schema/fleet-events.ts",
    "./src/db/schema/gateway-metrics.ts",
    "./src/db/schema/rate-limit-entries.ts",
    "./src/db/schema/circuit-breaker-states.ts",
    "./src/db/schema/provisioned-phone-numbers.ts",
    "./src/db/schema/tenant-model-selection.ts",
  ],
  out: "./drizzle/migrations",
  dialect: "sqlite",
  dbCredentials: { url: process.env.DATABASE_PATH || "./data/platform.db" },
});
