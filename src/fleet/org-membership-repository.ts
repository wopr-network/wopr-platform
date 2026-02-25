/**
 * Repository for org-level tenant membership lookups (BYOK key resolution).
 *
 * Follows the mandatory repository pattern: IOrgMembershipRepository interface +
 * DrizzleOrgMembershipRepository implementation in the same file.
 * See: src/fleet/bot-instance-repository.ts
 *
 * NOTE: This repository queries the `org_memberships` table, which lives in
 * tenant-keys.db (not platform.db). It is used by org-key resolution to
 * determine which org tenant's BYOK keys to fall back to.
 */

import { eq } from "drizzle-orm";
import type { DrizzleDb } from "../db/index.js";
import { orgMemberships } from "../db/schema/org-memberships.js";

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface IOrgMembershipRepository {
  /** Return the org tenant ID for the given member tenant, or null if not a member. */
  getOrgTenantIdForMember(memberTenantId: string): string | null;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class DrizzleOrgMembershipRepository implements IOrgMembershipRepository {
  constructor(private readonly db: DrizzleDb) {}

  getOrgTenantIdForMember(memberTenantId: string): string | null {
    const row = this.db
      .select({ orgTenantId: orgMemberships.orgTenantId })
      .from(orgMemberships)
      .where(eq(orgMemberships.memberTenantId, memberTenantId))
      .get();
    return row?.orgTenantId ?? null;
  }
}
