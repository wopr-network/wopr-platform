-- WOP-1XXX: promotions system — 4 new tables
CREATE TYPE "public"."promotion_type" AS ENUM('bonus_on_purchase', 'coupon_fixed', 'coupon_unique', 'batch_grant');
--> statement-breakpoint
CREATE TYPE "public"."promotion_status" AS ENUM('draft', 'scheduled', 'active', 'paused', 'expired', 'cancelled');
--> statement-breakpoint
CREATE TYPE "public"."promotion_value_type" AS ENUM('flat_credits', 'percent_of_purchase');
--> statement-breakpoint
CREATE TYPE "public"."promotion_user_segment" AS ENUM('all', 'new_users', 'existing_users', 'tenant_list');
--> statement-breakpoint
CREATE TYPE "public"."rate_override_status" AS ENUM('scheduled', 'active', 'expired', 'cancelled');
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "promotions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "type" "promotion_type" NOT NULL,
  "status" "promotion_status" DEFAULT 'draft' NOT NULL,
  "starts_at" timestamp with time zone,
  "ends_at" timestamp with time zone,
  "value_type" "promotion_value_type" NOT NULL,
  "value_amount" integer NOT NULL,
  "max_value_credits" integer,
  "first_purchase_only" boolean DEFAULT false NOT NULL,
  "min_purchase_credits" integer,
  "user_segment" "promotion_user_segment" DEFAULT 'all' NOT NULL,
  "eligible_tenant_ids" text[],
  "total_use_limit" integer,
  "per_user_limit" integer DEFAULT 1 NOT NULL,
  "budget_credits" integer,
  "total_uses" integer DEFAULT 0 NOT NULL,
  "total_credits_granted" integer DEFAULT 0 NOT NULL,
  "coupon_code" text,
  "coupon_batch_id" uuid,
  "created_by" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "notes" text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "promotions_status_idx" ON "promotions" ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "promotions_coupon_code_idx" ON "promotions" ("coupon_code");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "coupon_codes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "promotion_id" uuid NOT NULL REFERENCES "promotions"("id"),
  "code" text NOT NULL UNIQUE,
  "assigned_tenant_id" text,
  "assigned_email" text,
  "redeemed_at" timestamp with time zone,
  "redeemed_by_tenant_id" text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "coupon_codes_promotion_idx" ON "coupon_codes" ("promotion_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "coupon_codes_assigned_tenant_idx" ON "coupon_codes" ("assigned_tenant_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "promotion_redemptions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "promotion_id" uuid NOT NULL REFERENCES "promotions"("id"),
  "tenant_id" text NOT NULL,
  "coupon_code_id" uuid,
  "credits_granted" integer NOT NULL,
  "credit_transaction_id" text NOT NULL,
  "purchase_amount_credits" integer,
  "redeemed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "promotion_redemptions_promotion_idx" ON "promotion_redemptions" ("promotion_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "promotion_redemptions_tenant_idx" ON "promotion_redemptions" ("tenant_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "adapter_rate_overrides" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "adapter_id" text NOT NULL,
  "name" text NOT NULL,
  "discount_percent" integer NOT NULL,
  "starts_at" timestamp with time zone NOT NULL,
  "ends_at" timestamp with time zone,
  "status" "rate_override_status" DEFAULT 'scheduled' NOT NULL,
  "created_by" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "notes" text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "adapter_rate_overrides_adapter_idx" ON "adapter_rate_overrides" ("adapter_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "adapter_rate_overrides_status_idx" ON "adapter_rate_overrides" ("status");
