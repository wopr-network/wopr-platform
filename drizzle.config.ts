import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: [
    "./src/db/schema/bot-instances.ts",
    "./src/db/schema/credits.ts",
    "./src/db/schema/email-notifications.ts",
    "./src/db/schema/meter-events.ts",
    "./src/db/schema/stripe.ts",
    "./src/db/schema/audit.ts",
    "./src/db/schema/admin-audit.ts",
    "./src/db/schema/provider-credentials.ts",
    "./src/db/schema/snapshots.ts",
    "./src/db/schema/tenant-status.ts",
    "./src/db/schema/nodes.ts",
    "./src/db/schema/recovery-events.ts",
  ],
  out: "./drizzle/migrations",
  dialect: "sqlite",
  dbCredentials: { url: process.env.DATABASE_PATH || "./data/platform.db" },
});
