/** User context set by auth middleware, available via `c.get("user")`. */
export interface AuditUser {
  id: string;
  tier?: string;
  isAdmin?: boolean;
}

/** Hono environment variables for audit-aware routes. */
export interface AuditEnv {
  Variables: {
    user: AuditUser;
    authMethod: "session" | "api_key";
  };
}
