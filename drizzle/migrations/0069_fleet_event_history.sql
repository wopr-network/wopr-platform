CREATE TABLE "fleet_event_history" (
	"id" serial PRIMARY KEY NOT NULL,
	"event_type" text NOT NULL,
	"bot_id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"created_at" bigint NOT NULL
);
