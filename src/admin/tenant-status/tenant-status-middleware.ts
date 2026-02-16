import type { Context, Next } from "hono";
import type { TenantStatusRepository } from "../../domain/repositories/tenant-status-repository.js";
import { TenantId } from "../../domain/value-objects/tenant-id.js";

/**
 * Callback that resolves a tenant ID from the Hono context.
 */
export type ResolveTenantId = (c: Context) => string | undefined;

export interface TenantStatusGateConfig {
  /** TenantStatusRepository instance for checking account state. */
  statusRepo: TenantStatusRepository;
  /** Resolve the tenant ID from the request context. */
  resolveTenantId: ResolveTenantId;
}

function getStatusString(repo: TenantStatusRepository, tenantId: string): Promise<string> {
  return repo.get(TenantId.create(tenantId)).then((row) => row?.status ?? "active");
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

    const status = await getStatusString(cfg.statusRepo, tenantId);

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
  statusRepo: TenantStatusRepository,
  tenantId: string,
): Promise<{ error: string; message: string } | null> {
  const status = await getStatusString(statusRepo, tenantId);

  if (status === "active" || status === "grace_period") {
    return null;
  }

  if (status === "banned") {
    return { error: "account_banned", message: "This account has been permanently banned. Contact support." };
  }

  return { error: "account_suspended", message: "This account is suspended. Contact support." };
}
