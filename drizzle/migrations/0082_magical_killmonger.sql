CREATE TABLE "address_pool" (
	"id" serial PRIMARY KEY NOT NULL,
	"key_ring_id" text NOT NULL,
	"derivation_index" integer NOT NULL,
	"public_key" text NOT NULL,
	"address" text NOT NULL,
	"assigned_to" text,
	"created_at" text DEFAULT (now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "key_rings" (
	"id" text PRIMARY KEY NOT NULL,
	"curve" text NOT NULL,
	"derivation_scheme" text NOT NULL,
	"derivation_mode" text DEFAULT 'on-demand' NOT NULL,
	"key_material" text DEFAULT '{}' NOT NULL,
	"coin_type" integer NOT NULL,
	"account_index" integer DEFAULT 0 NOT NULL,
	"created_at" text DEFAULT (now()) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payment_methods" ADD COLUMN "rpc_headers" text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_methods" ADD COLUMN "oracle_asset_id" text;--> statement-breakpoint
ALTER TABLE "payment_methods" ADD COLUMN "key_ring_id" text;--> statement-breakpoint
ALTER TABLE "payment_methods" ADD COLUMN "encoding" text;--> statement-breakpoint
ALTER TABLE "payment_methods" ADD COLUMN "plugin_id" text;--> statement-breakpoint
ALTER TABLE "address_pool" ADD CONSTRAINT "address_pool_key_ring_id_key_rings_id_fk" FOREIGN KEY ("key_ring_id") REFERENCES "public"."key_rings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "address_pool_ring_index" ON "address_pool" USING btree ("key_ring_id","derivation_index");--> statement-breakpoint
CREATE UNIQUE INDEX "key_rings_path_unique" ON "key_rings" USING btree ("coin_type","account_index");