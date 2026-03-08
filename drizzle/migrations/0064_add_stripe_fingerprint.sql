ALTER TABLE "credit_transactions" ADD COLUMN "stripe_fingerprint" text;
--> statement-breakpoint
CREATE INDEX "idx_credit_tx_fingerprint" ON "credit_transactions" ("stripe_fingerprint");
