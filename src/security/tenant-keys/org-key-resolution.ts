import { eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { orgMemberships } from "../../db/schema/org-memberships.js";
import type { Provider } from "../types.js";
import { resolveApiKey } from "./key-resolution.js";

/** Extended resolution result that includes "org" as a source. */
export interface OrgResolvedKey {
  key: string;
  source: "tenant" | "org" | "pooled";
  provider: Provider;
}

/**
 * Resolve API key with org fallback.
 *
 * Resolution order:
 * 1. Personal tenant BYOK key
 * 2. Org tenant BYOK key (if member belongs to an org)
 * 3. Pooled platform key
 * 4. null
 *
 * @param deriveKey - Function to derive encryption key for a given tenantId
 */
export function resolveApiKeyWithOrgFallback(
  db: BetterSQLite3Database<Record<string, unknown>>,
  tenantId: string,
  provider: Provider,
  encryptionKey: Buffer,
  pooledKeys: Map<Provider, string>,
  deriveKey: (tenantId: string) => Buffer,
): OrgResolvedKey | null {
  // 1. Check personal tenant key
  const personal = resolveApiKey(db, tenantId, provider, encryptionKey, new Map());
  if (personal) {
    return { key: personal.key, source: "tenant", provider };
  }

  // 2. Check org membership and org key
  const membership = db
    .select({ orgTenantId: orgMemberships.orgTenantId })
    .from(orgMemberships)
    .where(eq(orgMemberships.memberTenantId, tenantId))
    .get();

  if (membership) {
    const orgEncKey = deriveKey(membership.orgTenantId);
    const orgResult = resolveApiKey(db, membership.orgTenantId, provider, orgEncKey, new Map());
    if (orgResult) {
      return { key: orgResult.key, source: "org", provider };
    }
  }

  // 3. Pooled key
  const pooledKey = pooledKeys.get(provider);
  if (pooledKey) {
    return { key: pooledKey, source: "pooled", provider };
  }

  // 4. None
  return null;
}
