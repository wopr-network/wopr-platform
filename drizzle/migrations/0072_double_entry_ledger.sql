DO $$ BEGIN
  CREATE TYPE "public"."account_type" AS ENUM('asset','liability','equity','revenue','expense');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."entry_side" AS ENUM('debit','credit');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE TABLE "accounts" (
  "id" text PRIMARY KEY NOT NULL,
  "code" text NOT NULL,
  "name" text NOT NULL,
  "type" "account_type" NOT NULL,
  "normal_side" "entry_side" NOT NULL,
  "tenant_id" text,
  "created_at" text DEFAULT (now()) NOT NULL
);--> statement-breakpoint
CREATE TABLE "journal_entries" (
  "id" text PRIMARY KEY NOT NULL,
  "posted_at" text DEFAULT (now()) NOT NULL,
  "entry_type" text NOT NULL,
  "description" text,
  "reference_id" text,
  "tenant_id" text NOT NULL,
  "metadata" jsonb,
  "created_by" text
);--> statement-breakpoint
CREATE TABLE "journal_lines" (
  "id" text PRIMARY KEY NOT NULL,
  "journal_entry_id" text NOT NULL REFERENCES "journal_entries"("id"),
  "account_id" text NOT NULL REFERENCES "accounts"("id"),
  "amount" bigint NOT NULL,
  "side" "entry_side" NOT NULL
);--> statement-breakpoint
CREATE TABLE "account_balances" (
  "account_id" text PRIMARY KEY NOT NULL REFERENCES "accounts"("id"),
  "balance" bigint DEFAULT 0 NOT NULL,
  "last_updated" text DEFAULT (now()) NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX "idx_accounts_code" ON "accounts" USING btree ("code");--> statement-breakpoint
CREATE INDEX "idx_accounts_tenant" ON "accounts" USING btree ("tenant_id") WHERE "tenant_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_accounts_type" ON "accounts" USING btree ("type");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_je_reference" ON "journal_entries" USING btree ("reference_id") WHERE "reference_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_je_tenant" ON "journal_entries" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_je_type" ON "journal_entries" USING btree ("entry_type");--> statement-breakpoint
CREATE INDEX "idx_je_posted" ON "journal_entries" USING btree ("posted_at");--> statement-breakpoint
CREATE INDEX "idx_je_tenant_posted" ON "journal_entries" USING btree ("tenant_id", "posted_at");--> statement-breakpoint
CREATE INDEX "idx_jl_entry" ON "journal_lines" USING btree ("journal_entry_id");--> statement-breakpoint
CREATE INDEX "idx_jl_account" ON "journal_lines" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "idx_jl_account_side" ON "journal_lines" USING btree ("account_id", "side");--> statement-breakpoint
INSERT INTO "accounts" ("id", "code", "name", "type", "normal_side", "tenant_id") VALUES
  (gen_random_uuid()::text, '1000', 'Cash', 'asset', 'debit', NULL),
  (gen_random_uuid()::text, '1100', 'Stripe Receivable', 'asset', 'debit', NULL),
  (gen_random_uuid()::text, '3000', 'Retained Earnings', 'equity', 'credit', NULL),
  (gen_random_uuid()::text, '4000', 'Revenue: Bot Runtime', 'revenue', 'credit', NULL),
  (gen_random_uuid()::text, '4010', 'Revenue: Adapter Usage', 'revenue', 'credit', NULL),
  (gen_random_uuid()::text, '4020', 'Revenue: Addon', 'revenue', 'credit', NULL),
  (gen_random_uuid()::text, '4030', 'Revenue: Storage Upgrade', 'revenue', 'credit', NULL),
  (gen_random_uuid()::text, '4040', 'Revenue: Resource Upgrade', 'revenue', 'credit', NULL),
  (gen_random_uuid()::text, '4050', 'Revenue: Onboarding LLM', 'revenue', 'credit', NULL),
  (gen_random_uuid()::text, '4060', 'Revenue: Expired Credits', 'revenue', 'credit', NULL),
  (gen_random_uuid()::text, '5000', 'Expense: Signup Grant', 'expense', 'debit', NULL),
  (gen_random_uuid()::text, '5010', 'Expense: Admin Grant', 'expense', 'debit', NULL),
  (gen_random_uuid()::text, '5020', 'Expense: Promo', 'expense', 'debit', NULL),
  (gen_random_uuid()::text, '5030', 'Expense: Referral', 'expense', 'debit', NULL),
  (gen_random_uuid()::text, '5040', 'Expense: Affiliate', 'expense', 'debit', NULL),
  (gen_random_uuid()::text, '5050', 'Expense: Bounty', 'expense', 'debit', NULL),
  (gen_random_uuid()::text, '5060', 'Expense: Dividend', 'expense', 'debit', NULL),
  (gen_random_uuid()::text, '5070', 'Expense: Correction', 'expense', 'debit', NULL)
ON CONFLICT ("code") DO NOTHING;--> statement-breakpoint
INSERT INTO "account_balances" ("account_id", "balance")
  SELECT "id", 0 FROM "accounts" WHERE "tenant_id" IS NULL
ON CONFLICT ("account_id") DO NOTHING;
