CREATE TABLE "gateway_service_keys" (
  "id" text PRIMARY KEY NOT NULL,
  "key_hash" text NOT NULL,
  "tenant_id" text NOT NULL,
  "instance_id" text NOT NULL,
  "created_at" bigint NOT NULL,
  "revoked_at" bigint
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_gateway_service_keys_hash" ON "gateway_service_keys" USING btree ("key_hash");
--> statement-breakpoint
CREATE INDEX "idx_gateway_service_keys_tenant" ON "gateway_service_keys" USING btree ("tenant_id");
--> statement-breakpoint
CREATE INDEX "idx_gateway_service_keys_instance" ON "gateway_service_keys" USING btree ("instance_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_gateway_service_keys_active_instance" ON "gateway_service_keys" USING btree ("instance_id") WHERE "revoked_at" IS NULL;
