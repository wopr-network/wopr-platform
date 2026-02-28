-- WOP-1062: affiliate referral velocity cap
-- Add payout suppression columns to affiliate_referrals
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'affiliate_referrals' AND column_name = 'payout_suppressed'
  ) THEN
    ALTER TABLE "affiliate_referrals" ADD COLUMN "payout_suppressed" boolean NOT NULL DEFAULT false;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'affiliate_referrals' AND column_name = 'suppression_reason'
  ) THEN
    ALTER TABLE "affiliate_referrals" ADD COLUMN "suppression_reason" text;
  END IF;
END $$;
