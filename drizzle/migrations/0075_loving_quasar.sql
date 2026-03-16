DROP TABLE "payram_charges" CASCADE;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD COLUMN "fleet_updates" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_invites" ADD COLUMN "accepted_at" bigint;--> statement-breakpoint
ALTER TABLE "organization_invites" ADD COLUMN "revoked_at" bigint;