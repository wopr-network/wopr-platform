-- WOP-1059: Migrate credit columns from integer cents to bigint nanodollars
-- credit_transactions: amount_cents → amount_credits (bigint), balance_after_cents → balance_after_credits (bigint)
-- credit_balances: balance_cents → balance_credits (bigint)

ALTER TABLE "credit_transactions"
  ADD COLUMN "amount_credits" bigint,
  ADD COLUMN "balance_after_credits" bigint;
--> statement-breakpoint

UPDATE "credit_transactions"
  SET "amount_credits" = "amount_cents"::bigint * 10000000,
      "balance_after_credits" = "balance_after_cents"::bigint * 10000000;
--> statement-breakpoint

ALTER TABLE "credit_transactions"
  ALTER COLUMN "amount_credits" SET NOT NULL,
  ALTER COLUMN "balance_after_credits" SET NOT NULL;
--> statement-breakpoint

ALTER TABLE "credit_transactions"
  DROP COLUMN "amount_cents",
  DROP COLUMN "balance_after_cents";
--> statement-breakpoint

ALTER TABLE "credit_balances"
  ADD COLUMN "balance_credits" bigint;
--> statement-breakpoint

UPDATE "credit_balances"
  SET "balance_credits" = "balance_cents"::bigint * 10000000;
--> statement-breakpoint

ALTER TABLE "credit_balances"
  ALTER COLUMN "balance_credits" SET NOT NULL,
  ALTER COLUMN "balance_credits" SET DEFAULT 0;
--> statement-breakpoint

ALTER TABLE "credit_balances"
  DROP COLUMN "balance_cents";
