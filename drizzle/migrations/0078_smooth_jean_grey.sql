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
ALTER TABLE "payment_methods" ADD COLUMN "network" text DEFAULT 'mainnet' NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_methods" ADD COLUMN "next_index" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "derived_addresses" ADD CONSTRAINT "derived_addresses_chain_id_payment_methods_id_fk" FOREIGN KEY ("chain_id") REFERENCES "public"."payment_methods"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "path_allocations" ADD CONSTRAINT "path_allocations_chain_id_payment_methods_id_fk" FOREIGN KEY ("chain_id") REFERENCES "public"."payment_methods"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_derived_addresses_chain" ON "derived_addresses" USING btree ("chain_id");