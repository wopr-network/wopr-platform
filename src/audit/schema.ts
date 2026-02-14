import type Database from "better-sqlite3";

/** Valid auth methods for audit entries. */
export type AuthMethod = "session" | "api_key";

/** Valid resource types for audit entries. */
export type ResourceType = "instance" | "plugin" | "api_key" | "user" | "config" | "tier" | "email";

/** Valid audit actions. */
export type AuditAction =
  | "instance.create"
  | "instance.destroy"
  | "instance.start"
  | "instance.stop"
  | "plugin.install"
  | "plugin.uninstall"
  | "key.create"
  | "key.revoke"
  | "auth.login"
  | "auth.logout"
  | "auth.oauth_link"
  | "auth.email_verified"
  | "email.sent"
  | "tier.upgrade"
  | "tier.downgrade"
  | "config.update";

/** A single audit log entry as stored in the database. */
export interface AuditEntry {
  id: string;
  timestamp: number;
  user_id: string;
  auth_method: AuthMethod;
  action: AuditAction;
  resource_type: ResourceType;
  resource_id: string | null;
  details: string | null;
  ip_address: string | null;
  user_agent: string | null;
}

/** Parameters for creating a new audit entry (id and timestamp are generated). */
export interface AuditEntryInput {
  userId: string;
  authMethod: AuthMethod;
  action: AuditAction;
  resourceType: ResourceType;
  resourceId?: string | null;
  details?: Record<string, unknown> | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/** Initialize the audit_log table. */
export function initAuditSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      timestamp INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      auth_method TEXT NOT NULL,
      action TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT,
      details TEXT,
      ip_address TEXT,
      user_agent TEXT
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log (timestamp)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_audit_user_id ON audit_log (user_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log (action)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_audit_resource ON audit_log (resource_type, resource_id)");
}
