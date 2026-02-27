ALTER TABLE "onboarding_sessions" ADD COLUMN "graduated_at" bigint;--> statement-breakpoint
ALTER TABLE "onboarding_sessions" ADD COLUMN "graduation_path" text;--> statement-breakpoint
ALTER TABLE "onboarding_sessions" ADD COLUMN "total_platform_cost_usd" text;
