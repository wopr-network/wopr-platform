CREATE TABLE "gpu_allocations" (
	"id" text PRIMARY KEY NOT NULL,
	"gpu_node_id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"bot_instance_id" text,
	"priority" text DEFAULT 'normal' NOT NULL,
	"created_at" bigint DEFAULT (extract(epoch from now()))::bigint NOT NULL,
	"updated_at" bigint DEFAULT (extract(epoch from now()))::bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gpu_configurations" (
	"gpu_node_id" text PRIMARY KEY NOT NULL,
	"memory_limit_mib" integer,
	"model_assignments" text,
	"max_concurrency" integer DEFAULT 1 NOT NULL,
	"notes" text,
	"updated_at" bigint DEFAULT (extract(epoch from now()))::bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_gpu_allocations_gpu_node_id" ON "gpu_allocations" USING btree ("gpu_node_id");
--> statement-breakpoint
CREATE INDEX "idx_gpu_allocations_tenant_id" ON "gpu_allocations" USING btree ("tenant_id");
