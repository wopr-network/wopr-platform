import crypto from "node:crypto";
import type Database from "better-sqlite3";

export interface AdminNoteRow {
  id: string;
  tenant_id: string;
  admin_user: string;
  content: string;
  created_at: number;
}

export class AdminNotesStore {
  constructor(private readonly db: Database.Database) {}

  /** Append a note. Notes are immutable — no updates or deletes. */
  add(tenantId: string, adminUser: string, content: string): AdminNoteRow {
    const id = crypto.randomUUID();
    const createdAt = Date.now();
    this.db
      .prepare("INSERT INTO admin_notes (id, tenant_id, admin_user, content, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, tenantId, adminUser, content, createdAt);
    return { id, tenant_id: tenantId, admin_user: adminUser, content, created_at: createdAt };
  }

  /** List all notes for a tenant, newest first. */
  listForTenant(tenantId: string, limit = 100): AdminNoteRow[] {
    return this.db
      .prepare(
        "SELECT id, tenant_id, admin_user, content, created_at FROM admin_notes WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?",
      )
      .all(tenantId, limit) as AdminNoteRow[];
  }
}
