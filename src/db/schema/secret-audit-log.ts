import { sql } from "drizzle-orm";
import { bigint, index, pgTable, text } from "drizzle-orm/pg-core";

export const secretAuditLog = pgTable(
  "secret_audit_log",
  {
    id: text("id").primaryKey(),
    credentialId: text("credential_id").notNull(),
    accessedAt: bigint("accessed_at", { mode: "number" })
      .notNull()
      .default(sql`(extract(epoch from now()) * 1000)::bigint`),
    accessedBy: text("accessed_by").notNull(),
    action: text("action").notNull(), // "read" | "write" | "delete"
    ip: text("ip"),
  },
  (table) => [
    index("idx_secret_audit_credential").on(table.credentialId, table.accessedAt),
    index("idx_secret_audit_accessed_by").on(table.accessedBy),
  ],
);
