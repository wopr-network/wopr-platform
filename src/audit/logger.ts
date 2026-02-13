import crypto from "node:crypto";
import type Database from "better-sqlite3";
import type { AuditEntry, AuditEntryInput } from "./schema.js";

/** Append-only audit log writer. */
export class AuditLogger {
  private insertStmt: Database.Statement;

  constructor(db: Database.Database) {
    this.insertStmt = db.prepare(`
      INSERT INTO audit_log (id, timestamp, user_id, auth_method, action, resource_type, resource_id, details, ip_address, user_agent)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
  }

  /** Append a new audit entry. Returns the created entry. */
  log(input: AuditEntryInput): AuditEntry {
    const entry: AuditEntry = {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      user_id: input.userId,
      auth_method: input.authMethod,
      action: input.action,
      resource_type: input.resourceType,
      resource_id: input.resourceId ?? null,
      details: input.details ? JSON.stringify(input.details) : null,
      ip_address: input.ipAddress ?? null,
      user_agent: input.userAgent ?? null,
    };

    this.insertStmt.run(
      entry.id,
      entry.timestamp,
      entry.user_id,
      entry.auth_method,
      entry.action,
      entry.resource_type,
      entry.resource_id,
      entry.details,
      entry.ip_address,
      entry.user_agent,
    );

    return entry;
  }
}
