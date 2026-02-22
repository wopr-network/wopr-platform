import crypto from "node:crypto";
import type { IAuditLogRepository } from "./audit-log-repository.js";
import type { AuditEntry, AuditEntryInput } from "./schema.js";

/** Append-only audit log writer. */
export class AuditLogger {
  private repo: IAuditLogRepository;

  constructor(repo: IAuditLogRepository) {
    this.repo = repo;
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

    this.repo.insert(entry);

    return entry;
  }
}
