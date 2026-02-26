import type { IOrgMembershipRepository } from "../../fleet/org-membership-repository.js";
import type { Provider } from "../types.js";

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
 * @param lookupKey - Callback to look up a decrypted key for a given tenantId, provider, and encryption key
 * @param deriveKey - Function to derive encryption key for a given tenantId
 */
export async function resolveApiKeyWithOrgFallback(
  lookupKey: (tenantId: string, provider: Provider, encKey: Buffer) => Promise<string | null>,
  tenantId: string,
  provider: Provider,
  encryptionKey: Buffer,
  pooledKeys: Map<Provider, string>,
  deriveKey: (tenantId: string) => Buffer,
  orgMembershipRepo: IOrgMembershipRepository,
): Promise<OrgResolvedKey | null> {
  // 1. Check personal tenant key
  const personal = await lookupKey(tenantId, provider, encryptionKey);
  if (personal) {
    return { key: personal, source: "tenant", provider };
  }

  // 2. Check org membership and org key
  const orgTenantId = await orgMembershipRepo.getOrgTenantIdForMember(tenantId);

  if (orgTenantId) {
    const orgEncKey = deriveKey(orgTenantId);
    const orgResult = await lookupKey(orgTenantId, provider, orgEncKey);
    if (orgResult) {
      return { key: orgResult, source: "org", provider };
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
