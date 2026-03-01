CREATE TABLE "tenant_addons" (
  "tenant_id" text NOT NULL,
  "addon_key" text NOT NULL,
  "enabled_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "tenant_addons_pkey" PRIMARY KEY("tenant_id","addon_key")
);
--> statement-breakpoint
CREATE INDEX "idx_tenant_addons_tenant" ON "tenant_addons" USING btree ("tenant_id");
