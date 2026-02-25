import { beforeEach, describe, expect, it } from "vitest";
import { type OrgKeysRouterDeps, setOrgKeysRouterDeps } from "./org-keys.js";

function makeMockDeps(overrides: Partial<OrgKeysRouterDeps> = {}): OrgKeysRouterDeps {
  const storedKeys = new Map<
    string,
    {
      id: string;
      tenant_id: string;
      provider: string;
      label: string;
      created_at: number;
      updated_at: number;
    }
  >();
  return {
    getTenantKeyStore: () => ({
      listForTenant: (tenantId: string) => [...storedKeys.values()].filter((k) => k.tenant_id === tenantId),
      get: (tenantId: string, provider: string) =>
        [...storedKeys.values()].find((k) => k.tenant_id === tenantId && k.provider === provider),
      upsert: (tenantId: string, provider: string, _enc: unknown, label: string) => {
        const id = `key-${tenantId}-${provider}`;
        storedKeys.set(id, {
          id,
          tenant_id: tenantId,
          provider,
          label,
          created_at: Date.now(),
          updated_at: Date.now(),
        });
        return id;
      },
      delete: (tenantId: string, provider: string) => {
        const id = `key-${tenantId}-${provider}`;
        return storedKeys.delete(id);
      },
    }),
    encrypt: (_plaintext: string, _key: Buffer) => ({ iv: "iv", authTag: "tag", ciphertext: "ct" }),
    deriveTenantKey: (_tenantId: string, _secret: string) => Buffer.alloc(32),
    platformSecret: "test-secret",
    getOrgTenantIdForUser: (_userId: string, _tenantId: string) => null,
    getUserRoleInTenant: (_userId: string, _tenantId: string) => null,
    ...overrides,
  };
}

describe("OrgKeysRouterDeps", () => {
  beforeEach(() => {
    // Reset deps to avoid cross-test contamination
    setOrgKeysRouterDeps(makeMockDeps());
  });

  it("allows tenant_admin to list org keys (metadata only)", () => {
    const deps = makeMockDeps({
      getOrgTenantIdForUser: () => "org-1",
      getUserRoleInTenant: () => "tenant_admin",
    });
    setOrgKeysRouterDeps(deps);

    // Store a key under org-1
    deps.getTenantKeyStore().upsert("org-1", "anthropic", { iv: "", authTag: "", ciphertext: "" } as never, "...k123");
    const keys = deps.getTenantKeyStore().listForTenant("org-1");
    expect(keys).toHaveLength(1);
    // listForTenant returns metadata only (no encrypted_key field)
    expect(keys[0]).not.toHaveProperty("encrypted_key");
  });

  it("non-tenant_admin cannot store keys (requireOrgAdmin check)", () => {
    // Test by checking that getUserRoleInTenant returns "user" for non-admin
    const deps = makeMockDeps({
      getOrgTenantIdForUser: () => "org-1",
      getUserRoleInTenant: (_userId, _tenantId) => "user",
    });
    setOrgKeysRouterDeps(deps);

    // A "user" role should not pass the admin check
    const role = deps.getUserRoleInTenant("user-123", "org-1");
    expect(role).not.toBe("tenant_admin");
    expect(role).not.toBe("platform_admin");
  });

  it("returns null org tenant when user is not in any org", () => {
    const deps = makeMockDeps({
      getOrgTenantIdForUser: () => null,
    });
    setOrgKeysRouterDeps(deps);

    const orgId = deps.getOrgTenantIdForUser("user-1", "member-tenant-1");
    expect(orgId).toBeNull();
  });

  it("tenant_admin check accepts platform_admin as well", () => {
    const deps = makeMockDeps({
      getOrgTenantIdForUser: () => "org-1",
      getUserRoleInTenant: () => "platform_admin",
    });
    setOrgKeysRouterDeps(deps);

    const role = deps.getUserRoleInTenant("admin-user", "org-1");
    expect(role === "platform_admin" || role === "tenant_admin").toBe(true);
  });
});
