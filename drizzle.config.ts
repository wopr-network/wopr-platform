import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: [
    "./src/db/schema/admin-audit.ts",
    "./src/db/schema/admin-notes.ts",
    "./src/db/schema/audit.ts",
    "./src/db/schema/bot-instances.ts",
    "./src/db/schema/bot-profiles.ts",
    "./src/db/schema/credits.ts",
    "./src/db/schema/email-notifications.ts",
    "./src/db/schema/meter-events.ts",
    "./src/db/schema/node-registration-tokens.ts",
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
    "./src/db/schema/user-roles.ts",
  ],
  out: "./drizzle/migrations",
  dialect: "sqlite",
  dbCredentials: { url: process.env.DATABASE_PATH || "./data/platform.db" },
});
