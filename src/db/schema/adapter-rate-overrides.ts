import { index, integer, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const rateOverrideStatusEnum = pgEnum("rate_override_status", ["scheduled", "active", "expired", "cancelled"]);

export const adapterRateOverrides = pgTable(
  "adapter_rate_overrides",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    adapterId: text("adapter_id").notNull(),
    name: text("name").notNull(),
    discountPercent: integer("discount_percent").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    status: rateOverrideStatusEnum("status").notNull().default("scheduled"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    notes: text("notes"),
  },
  (t) => [
    index("adapter_rate_overrides_adapter_idx").on(t.adapterId),
    index("adapter_rate_overrides_status_idx").on(t.status),
  ],
);
