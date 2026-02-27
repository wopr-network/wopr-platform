ALTER TABLE "credit_transactions" RENAME COLUMN "amount_cents" TO "amount_credits";--> statement-breakpoint
ALTER TABLE "credit_transactions" RENAME COLUMN "balance_after_cents" TO "balance_after_credits";--> statement-breakpoint
ALTER TABLE "credit_balances" RENAME COLUMN "balance_cents" TO "balance_credits";--> statement-breakpoint
ALTER TABLE "dividend_distributions" RENAME COLUMN "amount_cents" TO "amount_credits";--> statement-breakpoint
ALTER TABLE "dividend_distributions" RENAME COLUMN "pool_cents" TO "pool_credits";--> statement-breakpoint
ALTER TABLE "credit_auto_topup" RENAME COLUMN "amount_cents" TO "amount_credits";--> statement-breakpoint
ALTER TABLE "credit_auto_topup_settings" RENAME COLUMN "usage_threshold_cents" TO "usage_threshold_credits";--> statement-breakpoint
ALTER TABLE "credit_auto_topup_settings" RENAME COLUMN "usage_topup_cents" TO "usage_topup_credits";--> statement-breakpoint
ALTER TABLE "credit_auto_topup_settings" RENAME COLUMN "schedule_amount_cents" TO "schedule_amount_credits";--> statement-breakpoint
ALTER TABLE "onboarding_sessions" RENAME COLUMN "budget_used_cents" TO "budget_used_credits";--> statement-breakpoint
ALTER TABLE "admin_users" RENAME COLUMN "credit_balance_cents" TO "credit_balance_credits";--> statement-breakpoint
ALTER TABLE "affiliate_referrals" RENAME COLUMN "match_amount_cents" TO "match_amount_credits";--> statement-breakpoint
ALTER TABLE "bulk_undo_grants" RENAME COLUMN "amount_cents" TO "amount_credits";
