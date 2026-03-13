CREATE TABLE "archived_journal_entries" (
  "id" text PRIMARY KEY NOT NULL,
  "posted_at" text NOT NULL,
  "entry_type" text NOT NULL,
  "lines" jsonb NOT NULL,
  "archived_at" text DEFAULT (now()::text) NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_aje_entry_type" ON "archived_journal_entries" USING btree ("entry_type");
--> statement-breakpoint
CREATE INDEX "idx_aje_posted_at" ON "archived_journal_entries" USING btree ("posted_at");
