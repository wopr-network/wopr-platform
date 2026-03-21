ALTER TABLE "crypto_charges" ADD COLUMN "confirmations" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "crypto_charges" ADD COLUMN "confirmations_required" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "crypto_charges" ADD COLUMN "tx_hash" text;--> statement-breakpoint
ALTER TABLE "crypto_charges" ADD COLUMN "amount_received_cents" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint