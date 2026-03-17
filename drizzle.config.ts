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
 * Drizzle-kit generates migrations from schema diffs. Schema definitions live in
 * @wopr-network/platform-core. After schema changes, bump the dependency version,
 * run `pnpm db:generate`, and review the generated SQL before committing.
 */
import { defineConfig } from "drizzle-kit";

const S = "./node_modules/@wopr-network/platform-core/dist/db/schema";

export default defineConfig({
  schema: [
    `${S}/account-deletion-requests.js`,
    `${S}/account-export-requests.js`,
    `${S}/admin-audit.js`,
    `${S}/admin-notes.js`,
    `${S}/admin-users.js`,
    `${S}/affiliate.js`,
    `${S}/audit.js`,
    `${S}/backup-status.js`,
    `${S}/bot-instances.js`,
    `${S}/bot-profiles.js`,
    `${S}/bulk-undo-grants.js`,
    `${S}/circuit-breaker-states.js`,
    `${S}/credit-auto-topup-settings.js`,
    `${S}/credit-auto-topup.js`,
    `${S}/credits.js`,
    `${S}/dividend-distributions.js`,
    `${S}/email-notifications.js`,
    `${S}/fleet-events.js`,
    `${S}/gateway-metrics.js`,
    `${S}/gpu-nodes.js`,
    `${S}/meter-events.js`,
    `${S}/node-registration-tokens.js`,
    `${S}/node-transitions.js`,
    `${S}/nodes.js`,
    `${S}/notification-preferences.js`,
    `${S}/notification-queue.js`,
    `${S}/oauth-states.js`,
    `${S}/org-memberships.js`,
    `${S}/organization-members.js`,
    `${S}/crypto.js`,
    `${S}/plugin-marketplace-content.js`,
    `${S}/provider-credentials.js`,
    `${S}/provider-health-overrides.js`,
    `${S}/provisioned-phone-numbers.js`,
    `${S}/rate-limit-entries.js`,
    `${S}/rates.js`,
    `${S}/recovery-events.js`,
    `${S}/restore-log.js`,
    `${S}/secret-audit-log.js`,
    `${S}/security-settings.js`,
    `${S}/snapshots.js`,
    `${S}/spending-limits.js`,
    `${S}/tenant-api-keys.js`,
    `${S}/tenant-capability-settings.js`,
    `${S}/tenant-customers.js`,
    `${S}/tenant-model-selection.js`,
    `${S}/tenant-status.js`,
    `${S}/tenants.js`,
    `${S}/user-roles.js`,
    `${S}/vps-subscriptions.js`,
    `${S}/webhook-seen-events.js`,
    `${S}/webhook-sig-penalties.js`,
    `${S}/marketplace-plugins.js`,
    `${S}/onboarding-sessions.js`,
    `${S}/session-usage.js`,
    `${S}/setup-sessions.js`,
    `${S}/promotions.js`,
    `${S}/coupon-codes.js`,
    `${S}/promotion-redemptions.js`,
    `${S}/adapter-rate-overrides.js`,
    `${S}/page-contexts.js`,
  ],
  out: "./drizzle/migrations",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL || "postgres://localhost/wopr" },
});
