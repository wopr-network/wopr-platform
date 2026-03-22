ALTER TABLE "payment_methods" ADD COLUMN "icon_url" text;--> statement-breakpoint
ALTER TABLE "payment_methods" ADD COLUMN "address_type" text DEFAULT 'evm' NOT NULL;