CREATE TABLE "crypto_charges" (
	"reference_id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"amount_usd_cents" integer NOT NULL,
	"status" text DEFAULT 'New' NOT NULL,
	"currency" text,
	"filled_amount" text,
	"created_at" text DEFAULT (now()) NOT NULL,
	"updated_at" text DEFAULT (now()) NOT NULL,
	"credited_at" text,
	"chain" text,
	"token" text,
	"deposit_address" text,
	"derivation_index" integer
);
--> statement-breakpoint
CREATE TABLE "payment_methods" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"token" text NOT NULL,
	"chain" text NOT NULL,
	"contract_address" text,
	"decimals" integer NOT NULL,
	"display_name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"rpc_url" text,
	"oracle_address" text,
	"xpub" text,
	"confirmations" integer DEFAULT 1 NOT NULL,
	"created_at" text DEFAULT (now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "watcher_cursors" (
	"watcher_id" text PRIMARY KEY NOT NULL,
	"cursor_block" integer NOT NULL,
	"updated_at" text DEFAULT (now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "watcher_processed" (
	"watcher_id" text NOT NULL,
	"tx_id" text NOT NULL,
	"processed_at" text DEFAULT (now()) NOT NULL,
	CONSTRAINT "watcher_processed_watcher_id_tx_id_pk" PRIMARY KEY("watcher_id","tx_id")
);
--> statement-breakpoint
CREATE INDEX "idx_crypto_charges_tenant" ON "crypto_charges" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_crypto_charges_status" ON "crypto_charges" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_crypto_charges_created" ON "crypto_charges" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_crypto_charges_deposit_address" ON "crypto_charges" USING btree ("deposit_address");