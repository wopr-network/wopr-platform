import { TRPCError } from "@trpc/server";
import type { EncryptedPayload } from "@wopr-network/platform-core/security/types";
import { providerSchema } from "@wopr-network/platform-core/security/types";
import { router, tenantProcedure } from "@wopr-network/platform-core/trpc";
import { z } from "zod";

export interface OrgKeysRouterDeps {
  getTenantKeyRepository: () => {
    listForTenant: (tenantId: string) => Promise<unknown[]>;
    get: (
      tenantId: string,
      provider: string,
    ) => Promise<
      | {
          id: string;
          tenant_id: string;
          provider: string;
          label: string;
          created_at: number;
          updated_at: number;
        }
      | undefined
    >;
    upsert: (tenantId: string, provider: string, encryptedPayload: EncryptedPayload, label: string) => Promise<string>;
    delete: (tenantId: string, provider: string) => Promise<boolean>;
  };
  encrypt: (plaintext: string, key: Buffer) => EncryptedPayload;
  deriveTenantKey: (tenantId: string, platformSecret: string) => Buffer;
  platformSecret: string | undefined;
  /** Given a userId and their personal tenantId, return the org tenantId they belong to, or null. */
  getOrgTenantIdForUser: (userId: string, memberTenantId: string) => Promise<string | null>;
  /** Get the user's role in a specific tenant. */
  getUserRoleInTenant: (userId: string, tenantId: string) => Promise<string | null>;
}

let _deps: OrgKeysRouterDeps | null = null;

export function setOrgKeysRouterDeps(deps: OrgKeysRouterDeps): void {
  _deps = deps;
}

function deps(): OrgKeysRouterDeps {
  if (!_deps) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Org keys not initialized" });
  return _deps;
}

/** Assert the caller is tenant_admin for the org. Throws FORBIDDEN otherwise. */
async function requireOrgAdmin(userId: string, orgTenantId: string): Promise<void> {
  const { getUserRoleInTenant } = deps();
  const role = await getUserRoleInTenant(userId, orgTenantId);
  if (role !== "tenant_admin" && role !== "platform_admin") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Only org tenant_admin can manage org keys",
    });
  }
}

/** Resolve the org tenantId for the caller. Throws NOT_FOUND if not in an org. */
async function resolveOrgTenantId(userId: string, memberTenantId: string): Promise<string> {
  const { getOrgTenantIdForUser } = deps();
  const orgTenantId = await getOrgTenantIdForUser(userId, memberTenantId);
  if (!orgTenantId) {
    throw new TRPCError({ code: "NOT_FOUND", message: "No org membership found" });
  }
  return orgTenantId;
}

export const orgKeysRouter = router({
  /** List org-level API keys (metadata only). Any org member can call this. */
  listOrgKeys: tenantProcedure.query(async ({ ctx }) => {
    const orgTenantId = await resolveOrgTenantId(ctx.user.id, ctx.tenantId);
    const { getTenantKeyRepository } = deps();
    const keys = await getTenantKeyRepository().listForTenant(orgTenantId);
    return { orgTenantId, keys };
  }),

  /** Check if org has a key for a provider. Any org member can call this. */
  getOrgKey: tenantProcedure.input(z.object({ provider: providerSchema })).query(async ({ input, ctx }) => {
    const orgTenantId = await resolveOrgTenantId(ctx.user.id, ctx.tenantId);
    const { getTenantKeyRepository } = deps();
    const record = await getTenantKeyRepository().get(orgTenantId, input.provider);
    if (!record) {
      throw new TRPCError({ code: "NOT_FOUND", message: "No org key stored for this provider" });
    }
    return {
      id: record.id,
      tenant_id: record.tenant_id,
      provider: record.provider,
      label: record.label,
      created_at: record.created_at,
      updated_at: record.updated_at,
    };
  }),

  /** Store or replace an org API key. Requires tenant_admin. */
  storeOrgKey: tenantProcedure
    .input(
      z.object({
        provider: providerSchema,
        apiKey: z.string().min(1),
        label: z.string().max(100).optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const orgTenantId = await resolveOrgTenantId(ctx.user.id, ctx.tenantId);
      await requireOrgAdmin(ctx.user.id, orgTenantId);

      const { getTenantKeyRepository, encrypt, deriveTenantKey, platformSecret } = deps();
      if (!platformSecret) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Platform secret not configured",
        });
      }

      const tenantKey = deriveTenantKey(orgTenantId, platformSecret);
      const encryptedPayload = encrypt(input.apiKey, tenantKey);
      const maskedLabel = input.label ?? `...${input.apiKey.slice(-4)}`;
      const id = await getTenantKeyRepository().upsert(orgTenantId, input.provider, encryptedPayload, maskedLabel);

      return { ok: true as const, id, provider: input.provider };
    }),

  /** Delete an org API key. Requires tenant_admin. */
  deleteOrgKey: tenantProcedure.input(z.object({ provider: providerSchema })).mutation(async ({ input, ctx }) => {
    const orgTenantId = await resolveOrgTenantId(ctx.user.id, ctx.tenantId);
    await requireOrgAdmin(ctx.user.id, orgTenantId);

    const { getTenantKeyRepository } = deps();
    const deleted = await getTenantKeyRepository().delete(orgTenantId, input.provider);
    if (!deleted) {
      throw new TRPCError({ code: "NOT_FOUND", message: "No org key stored for this provider" });
    }
    return { ok: true as const, provider: input.provider };
  }),
});
