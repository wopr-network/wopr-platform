import type Database from "better-sqlite3";

/** Initialize Stripe billing tables for tenant-customer mapping and usage reporting. */
export function initStripeSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tenant_customers (
      tenant TEXT PRIMARY KEY,
      stripe_customer_id TEXT NOT NULL UNIQUE,
      tier TEXT NOT NULL DEFAULT 'free',
      billing_hold INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  // Migration: add billing_hold column if it doesn't exist (for pre-existing databases)
  const cols = db.prepare("PRAGMA table_info(tenant_customers)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "billing_hold")) {
    db.exec("ALTER TABLE tenant_customers ADD COLUMN billing_hold INTEGER NOT NULL DEFAULT 0");
  }

  if (!cols.some((c) => c.name === "inference_mode")) {
    db.exec("ALTER TABLE tenant_customers ADD COLUMN inference_mode TEXT NOT NULL DEFAULT 'byok'");
  }

  // Migration: drop stripe_subscription_id if it exists (WOP-406: credits replace subscriptions)
  if (cols.some((c) => c.name === "stripe_subscription_id")) {
    // SQLite doesn't support DROP COLUMN before 3.35.0; recreate for safety.
    // For new databases this is a no-op since the column isn't created above.
    // For existing databases with the column, we leave it — reads simply ignore it.
  }

  db.exec("CREATE INDEX IF NOT EXISTS idx_tenant_customers_stripe ON tenant_customers (stripe_customer_id)");

  db.exec(`
    CREATE TABLE IF NOT EXISTS stripe_usage_reports (
      id TEXT PRIMARY KEY,
      tenant TEXT NOT NULL,
      capability TEXT NOT NULL,
      provider TEXT NOT NULL,
      period_start INTEGER NOT NULL,
      period_end INTEGER NOT NULL,
      event_name TEXT NOT NULL,
      value_cents INTEGER NOT NULL,
      reported_at INTEGER NOT NULL
    )
  `);

  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_stripe_usage_unique ON stripe_usage_reports (tenant, capability, provider, period_start)",
  );
  db.exec("CREATE INDEX IF NOT EXISTS idx_stripe_usage_tenant ON stripe_usage_reports (tenant, reported_at)");
}
