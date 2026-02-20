/**
 * Service key authentication middleware for the API gateway.
 *
 * Bots authenticate with WOPR service keys (not provider API keys).
 * This middleware extracts the bearer token, resolves the tenant,
 * and sets gateway context for downstream handlers.
 */

import type { Context, Next } from "hono";
import { logger } from "../config/logger.js";
import type { GatewayTenant } from "./types.js";

export interface GatewayAuthEnv {
  Variables: {
    gatewayTenant: GatewayTenant;
    webhookBody: Record<string, unknown>;
  };
}

/**
 * Create middleware that authenticates WOPR service keys.
 *
 * Extracts the bearer token from the Authorization header, resolves
 * it to a tenant via the provided resolver function, and stores
 * the tenant in the Hono context for downstream handlers.
 *
 * @param resolveServiceKey - Function that maps a service key to a tenant (or null)
 */
export function serviceKeyAuth(resolveServiceKey: (key: string) => GatewayTenant | null) {
  return async (c: Context<GatewayAuthEnv>, next: Next) => {
    const authHeader = c.req.header("Authorization");
    if (!authHeader) {
      return c.json(
        {
          error: {
            message: "Missing Authorization header",
            type: "authentication_error",
            code: "missing_api_key",
          },
        },
        401,
      );
    }

    const trimmed = authHeader.trim();
    if (!trimmed.toLowerCase().startsWith("bearer ")) {
      return c.json(
        {
          error: {
            message: "Invalid Authorization header format. Expected: Bearer <service_key>",
            type: "authentication_error",
            code: "invalid_auth_format",
          },
        },
        401,
      );
    }

    const serviceKey = trimmed.slice(7).trim();
    if (!serviceKey) {
      return c.json(
        {
          error: {
            message: "Empty service key",
            type: "authentication_error",
            code: "missing_api_key",
          },
        },
        401,
      );
    }

    const tenant = resolveServiceKey(serviceKey);
    if (!tenant) {
      logger.warn("Invalid service key attempted", {
        keyPrefix: `${serviceKey.slice(0, 8)}...`,
      });
      return c.json(
        {
          error: {
            message: "Invalid or expired service key",
            type: "authentication_error",
            code: "invalid_api_key",
          },
        },
        401,
      );
    }

    c.set("gatewayTenant", tenant);
    return next();
  };
}
