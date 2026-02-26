import type { Context, Next } from "hono";
import type { ITenantStatusRepository } from "./tenant-status-repository.js";

/**
 * Callback that resolves a tenant ID from the Hono context.
 */
export type ResolveTenantId = (c: Context) => string | undefined;

export interface TenantStatusGateConfig {
  /** Status repository for checking account state. */
  statusStore: ITenantStatusRepository;
  /** Resolve the tenant ID from the request context. */
  resolveTenantId: ResolveTenantId;
}

/**
 * Create a middleware that checks tenant account status before processing.
 *
 * Returns 403 for suspended/banned accounts with appropriate error codes.
 * Allows active and grace_period accounts through.
 */
export function createTenantStatusGate(cfg: TenantStatusGateConfig) {
  return async (c: Context, next: Next) => {
    const tenantId = cfg.resolveTenantId(c);
    if (!tenantId) {
      return next();
    }

    const row = await cfg.statusStore.get(tenantId);
    const status = row?.status ?? "active";

    if (status === "active" || status === "grace_period") {
      return next();
    }

    if (status === "banned") {
      return c.json(
        {
          error: "account_banned",
          message: "This account has been permanently banned. Contact support.",
        },
        403,
      );
    }

    // suspended
    return c.json(
      {
        error: "account_suspended",
        message: "This account is suspended. Contact support.",
      },
      403,
    );
  };
}

/**
 * Check tenant status for the socket layer (non-HTTP context).
 *
 * Returns an error object if the tenant is not operational, null otherwise.
 */
export async function checkTenantStatus(
  statusStore: ITenantStatusRepository,
  tenantId: string,
): Promise<{ error: string; message: string } | null> {
  const row = await statusStore.get(tenantId);
  const status = row?.status ?? "active";

  if (status === "active" || status === "grace_period") {
    return null;
  }

  if (status === "banned") {
    return { error: "account_banned", message: "This account has been permanently banned. Contact support." };
  }

  return { error: "account_suspended", message: "This account is suspended. Contact support." };
}
