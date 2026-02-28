-- WOP-1061: affiliate self-referral fraud detection
-- Add signup signal columns to affiliate_referrals
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'affiliate_referrals' AND column_name = 'signup_ip'
  ) THEN
    ALTER TABLE "affiliate_referrals" ADD COLUMN "signup_ip" text;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'affiliate_referrals' AND column_name = 'signup_email'
  ) THEN
    ALTER TABLE "affiliate_referrals" ADD COLUMN "signup_email" text;
  END IF;
END $$;
--> statement-breakpoint
-- Create affiliate_fraud_events table
CREATE TABLE IF NOT EXISTS "affiliate_fraud_events" (
  "id" text PRIMARY KEY NOT NULL,
  "referral_id" text NOT NULL,
  "referrer_tenant_id" text NOT NULL,
  "referred_tenant_id" text NOT NULL,
  "verdict" text NOT NULL,
  "signals" text NOT NULL,
  "signal_details" text NOT NULL,
  "phase" text NOT NULL,
  "created_at" text NOT NULL DEFAULT (now())
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_fraud_referrer" ON "affiliate_fraud_events" ("referrer_tenant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_fraud_referred" ON "affiliate_fraud_events" ("referred_tenant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_fraud_verdict" ON "affiliate_fraud_events" ("verdict");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_fraud_referral_phase" ON "affiliate_fraud_events" ("referral_id", "phase");
