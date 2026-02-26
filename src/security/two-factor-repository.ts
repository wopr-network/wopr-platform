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
  getMandateStatus(tenantId: string): Promise<TenantMandateStatus>;
  setMandateStatus(tenantId: string, requireTwoFactor: boolean): Promise<TenantMandateStatus>;
}

// ---------------------------------------------------------------------------
// Drizzle implementation
// ---------------------------------------------------------------------------

export class DrizzleTwoFactorRepository implements ITwoFactorRepository {
  constructor(private readonly db: DrizzleDb) {}

  async getMandateStatus(tenantId: string): Promise<TenantMandateStatus> {
    const row = (
      await this.db.select().from(tenantSecuritySettings).where(eq(tenantSecuritySettings.tenantId, tenantId))
    )[0];
    return { tenantId, requireTwoFactor: row?.requireTwoFactor ?? false };
  }

  async setMandateStatus(tenantId: string, requireTwoFactor: boolean): Promise<TenantMandateStatus> {
    const now = Date.now();
    await this.db
      .insert(tenantSecuritySettings)
      .values({ tenantId, requireTwoFactor, updatedAt: now })
      .onConflictDoUpdate({
        target: tenantSecuritySettings.tenantId,
        set: { requireTwoFactor, updatedAt: now },
      });
    return { tenantId, requireTwoFactor };
  }
}
