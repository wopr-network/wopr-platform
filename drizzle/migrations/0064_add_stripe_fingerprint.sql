ALTER TABLE "credit_transactions" ADD COLUMN "stripe_fingerprint" text;
--> statement-breakpoint
-- NOTE: CREATE INDEX CONCURRENTLY cannot run inside a transaction.
-- Run this statement separately (outside any transaction block) during deployment,
-- after applying the ALTER TABLE above.
CREATE INDEX CONCURRENTLY "idx_credit_tx_fingerprint" ON "credit_transactions" ("stripe_fingerprint") WHERE "stripe_fingerprint" IS NOT NULL;
