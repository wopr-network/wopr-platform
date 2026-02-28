import type { Context, Next } from "hono";
import { getClientIpFromContext } from "../api/middleware/get-client-ip.js";
import type { AuditLogger } from "./logger.js";
import type { AuditAction, ResourceType } from "./schema.js";
import type { AuditEnv } from "./types.js";

/** Extract resource type from a URL path segment. */
export function extractResourceType(path: string): ResourceType {
  if (path.includes("/instance")) return "instance";
  if (path.includes("/plugin")) return "plugin";
  if (path.includes("/key")) return "api_key";
  if (path.includes("/user") || path.includes("/auth")) return "user";
  if (path.includes("/config")) return "config";
  if (path.includes("/tier")) return "tier";
  return "instance"; // default fallback
}

/**
 * Create a Hono middleware that logs an audit entry after a successful response.
 *
 * Expects `c.get("user")` to return `{ id: string }` and
 * `c.get("authMethod")` to return `"session" | "api_key"`.
 * If user context is not set (e.g., unauthenticated route), the middleware is a no-op.
 */
export function auditLog(logger: AuditLogger, action: AuditAction) {
  return async (c: Context<AuditEnv>, next: Next) => {
    await next();

    if (!c.res.ok) return;

    let user: { id: string } | undefined;
    try {
      user = c.get("user");
    } catch {
      return;
    }
    if (!user) return;

    let authMethod: "session" | "api_key" = "session";
    try {
      authMethod = c.get("authMethod") ?? "session";
    } catch {
      // default to session
    }

    try {
      const clientIp = getClientIpFromContext(c);
      await logger.log({
        userId: user.id,
        authMethod,
        action,
        resourceType: extractResourceType(c.req.path),
        resourceId: c.req.param("id") ?? null,
        ipAddress: clientIp === "unknown" ? null : clientIp,
        userAgent: c.req.header("user-agent") ?? null,
      });
    } catch {
      // Audit logging should never break the request flow.
    }
  };
}
