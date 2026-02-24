import { sql } from "drizzle-orm";
import { index, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Tracks phone numbers provisioned through the gateway for monthly billing.
 * Each row represents one active Twilio number owned by a tenant.
 */
export const provisionedPhoneNumbers = sqliteTable(
  "provisioned_phone_numbers",
  {
    sid: text("sid").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    phoneNumber: text("phone_number").notNull(),
    provisionedAt: text("provisioned_at").notNull().default(sql`(datetime('now'))`),
    lastBilledAt: text("last_billed_at"),
  },
  (table) => [
    index("idx_provisioned_phone_tenant").on(table.tenantId),
    index("idx_provisioned_phone_last_billed").on(table.lastBilledAt),
  ],
);
