-- Fix referential integrity: add FK on promotion_redemptions.coupon_code_id
ALTER TABLE "promotion_redemptions" ADD CONSTRAINT "promotion_redemptions_coupon_code_id_fkey"
  FOREIGN KEY ("coupon_code_id") REFERENCES "coupon_codes"("id");
--> statement-breakpoint
-- Fix double-grant: enforce uniqueness on promotions.coupon_code
ALTER TABLE "promotions" ADD CONSTRAINT "promotions_coupon_code_unique" UNIQUE ("coupon_code");
