import crypto from "node:crypto";
import type { DrizzleDb } from "../db/index.js";
import { auditLog } from "../db/schema/index.js";
import type { AuditEntry, AuditEntryInput } from "./schema.js";

/** Append-only audit log writer. */
export class AuditLogger {
  private db: DrizzleDb;

  constructor(db: DrizzleDb) {
    this.db = db;
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

    this.db
      .insert(auditLog)
      .values({
        id: entry.id,
        timestamp: entry.timestamp,
        userId: entry.user_id,
        authMethod: entry.auth_method,
        action: entry.action,
        resourceType: entry.resource_type,
        resourceId: entry.resource_id,
        details: entry.details,
        ipAddress: entry.ip_address,
        userAgent: entry.user_agent,
      })
      .run();

    return entry;
  }
}
