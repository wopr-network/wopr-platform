CREATE TABLE "derived_addresses" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "derived_addresses_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"chain_id" text NOT NULL,
	"derivation_index" integer NOT NULL,
	"address" text NOT NULL,
	"tenant_id" text,
	"created_at" text DEFAULT (now()) NOT NULL,
	CONSTRAINT "derived_addresses_address_unique" UNIQUE("address")
);
--> statement-breakpoint
CREATE TABLE "path_allocations" (
	"coin_type" integer NOT NULL,
	"account_index" integer NOT NULL,
	"chain_id" text,
	"xpub" text NOT NULL,
	"allocated_at" text DEFAULT (now()) NOT NULL,
	CONSTRAINT "path_allocations_coin_type_account_index_pk" PRIMARY KEY("coin_type","account_index")
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "webhook_deliveries_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	-- charge_id intentionally has no FK to crypto_charges: it mirrors the charge ID
	-- assigned by the crypto key server and the local row is created at checkout time,
	-- but delivery rows may arrive before the local charge row is fully committed.
	"charge_id" text NOT NULL,
	"callback_url" text NOT NULL,
	"payload" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_retry_at" text,
	"last_error" text,
	"created_at" text DEFAULT (now()) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "crypto_charges" ADD COLUMN "callback_url" text;--> statement-breakpoint
ALTER TABLE "crypto_charges" ADD COLUMN "expected_amount" text;--> statement-breakpoint
ALTER TABLE "crypto_charges" ADD COLUMN "received_amount" text;--> statement-breakpoint
ALTER TABLE "payment_methods" ADD COLUMN "network" text DEFAULT 'mainnet' NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_methods" ADD COLUMN "next_index" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "derived_addresses" ADD CONSTRAINT "derived_addresses_chain_id_payment_methods_id_fk" FOREIGN KEY ("chain_id") REFERENCES "public"."payment_methods"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "path_allocations" ADD CONSTRAINT "path_allocations_chain_id_payment_methods_id_fk" FOREIGN KEY ("chain_id") REFERENCES "public"."payment_methods"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_derived_addresses_chain" ON "derived_addresses" USING btree ("chain_id");--> statement-breakpoint
CREATE INDEX "idx_webhook_deliveries_status" ON "webhook_deliveries" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_webhook_deliveries_charge" ON "webhook_deliveries" USING btree ("charge_id");
