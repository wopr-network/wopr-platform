import type Database from "better-sqlite3";

/** Initialize Stripe billing tables for tenant-customer mapping and usage reporting. */
export function initStripeSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tenant_customers (
      tenant TEXT PRIMARY KEY,
      stripe_customer_id TEXT NOT NULL UNIQUE,
      stripe_subscription_id TEXT,
      tier TEXT NOT NULL DEFAULT 'free',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

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
