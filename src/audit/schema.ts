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
