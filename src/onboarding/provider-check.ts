import type { ISetupSessionRepository } from "../setup/setup-session-repository.js";

export type ProviderStatus = { configured: true; provider: string } | { configured: false };

/** Minimal interface for checking if a tenant has a BYOK key. */
export interface ITenantKeyLookup {
  findFirstByTenantId(tenantId: string): Promise<{ provider: string } | undefined>;
}

/**
 * Check if a tenant already has a provider configured.
 * Checks both BYOK keys in tenant_api_keys and "wopr-hosted" in setup session collected data.
 */
export async function checkProviderConfigured(
  keyLookup: ITenantKeyLookup,
  tenantId: string,
  opts?: { setupRepo?: Pick<ISetupSessionRepository, "findBySessionId">; sessionId?: string },
): Promise<ProviderStatus> {
  // 1. Check for BYOK key in tenant_api_keys
  const row = await keyLookup.findFirstByTenantId(tenantId);
  if (row) {
    return { configured: true, provider: row.provider };
  }

  // 2. Check setup session collected data for wopr-hosted
  if (opts?.setupRepo && opts.sessionId) {
    const session = await opts.setupRepo.findBySessionId(opts.sessionId);
    if (session?.collected) {
      try {
        const collected = JSON.parse(session.collected);
        if (collected.provider) {
          return { configured: true, provider: collected.provider };
        }
      } catch {
        // Invalid JSON in collected — treat as not configured
      }
    }
  }

  return { configured: false };
}
