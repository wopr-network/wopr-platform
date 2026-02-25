/**
 * Repository for tenant 2FA mandate settings.
 *
 * All drizzle-orm imports are confined to DrizzleTwoFactorRepository.
 * The tRPC router depends only on ITwoFactorRepository.
 */

import { eq } from "drizzle-orm";
import type { DrizzleDb } from "../db/index.js";
import { tenantSecuritySettings } from "../db/schema/security-settings.js";

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export interface TenantMandateStatus {
  tenantId: string;
  requireTwoFactor: boolean;
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface ITwoFactorRepository {
  getMandateStatus(tenantId: string): TenantMandateStatus;
  setMandateStatus(tenantId: string, requireTwoFactor: boolean): TenantMandateStatus;
}

// ---------------------------------------------------------------------------
// Drizzle implementation
// ---------------------------------------------------------------------------

export class DrizzleTwoFactorRepository implements ITwoFactorRepository {
  constructor(private readonly db: DrizzleDb) {}

  getMandateStatus(tenantId: string): TenantMandateStatus {
    const row = this.db
      .select()
      .from(tenantSecuritySettings)
      .where(eq(tenantSecuritySettings.tenantId, tenantId))
      .get();
    return { tenantId, requireTwoFactor: row?.requireTwoFactor ?? false };
  }

  setMandateStatus(tenantId: string, requireTwoFactor: boolean): TenantMandateStatus {
    const now = Date.now();
    this.db
      .insert(tenantSecuritySettings)
      .values({ tenantId, requireTwoFactor, updatedAt: now })
      .onConflictDoUpdate({
        target: tenantSecuritySettings.tenantId,
        set: { requireTwoFactor, updatedAt: now },
      })
      .run();
    return { tenantId, requireTwoFactor };
  }
}
