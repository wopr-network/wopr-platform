-- WOP-1074: Migrate meter pipeline cost/charge columns from real (float) to bigint (nano-dollars)
-- meter_events: cost/charge real -> bigint (Credit.toRaw() nano-dollar values)
-- usage_summaries: total_cost/total_charge real -> bigint
-- billing_period_summaries: total_cost/total_charge real -> bigint

ALTER TABLE "meter_events"
  ALTER COLUMN "cost" TYPE bigint USING ROUND("cost" * 1000000000)::bigint,
  ALTER COLUMN "charge" TYPE bigint USING ROUND("charge" * 1000000000)::bigint;
--> statement-breakpoint

ALTER TABLE "usage_summaries"
  ALTER COLUMN "total_cost" TYPE bigint USING ROUND("total_cost" * 1000000000)::bigint,
  ALTER COLUMN "total_charge" TYPE bigint USING ROUND("total_charge" * 1000000000)::bigint;
--> statement-breakpoint

ALTER TABLE "billing_period_summaries"
  ALTER COLUMN "total_cost" TYPE bigint USING ROUND("total_cost" * 1000000000)::bigint,
  ALTER COLUMN "total_charge" TYPE bigint USING ROUND("total_charge" * 1000000000)::bigint;
