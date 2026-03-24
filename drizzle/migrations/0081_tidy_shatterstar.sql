ALTER TABLE "payment_methods" ADD COLUMN "encoding_params" text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_methods" ADD COLUMN "watcher_type" text DEFAULT 'evm' NOT NULL;