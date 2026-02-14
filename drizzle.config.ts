import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: [
    "./src/db/schema/meter-events.ts",
    "./src/db/schema/stripe.ts",
    "./src/db/schema/audit.ts",
    "./src/db/schema/admin-audit.ts",
    "./src/db/schema/snapshots.ts",
  ],
  out: "./drizzle/migrations",
  dialect: "sqlite",
  dbCredentials: { url: process.env.DATABASE_PATH || "./data/platform.db" },
});
