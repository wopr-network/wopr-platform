import type Database from "better-sqlite3";

/** Initialize affiliate tables for testing. */
export function initAffiliateSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS affiliate_codes (
      tenant_id TEXT PRIMARY KEY NOT NULL,
      code TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS affiliate_referrals (
      id TEXT PRIMARY KEY NOT NULL,
      referrer_tenant_id TEXT NOT NULL,
      referred_tenant_id TEXT NOT NULL UNIQUE,
      code TEXT NOT NULL,
      signed_up_at TEXT NOT NULL DEFAULT (datetime('now')),
      first_purchase_at TEXT,
      match_amount_cents INTEGER,
      matched_at TEXT
    )
  `);

  db.exec("CREATE INDEX IF NOT EXISTS idx_affiliate_ref_referrer ON affiliate_referrals(referrer_tenant_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_affiliate_ref_code ON affiliate_referrals(code)");
}
