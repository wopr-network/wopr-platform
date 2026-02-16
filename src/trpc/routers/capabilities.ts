/**
 * tRPC capabilities router — BYOK/hosted toggle, key validation.
 *
 * Provides typed procedures for managing tenant API keys
 * and validating provider keys.
 */

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import type { TenantKeyRepository } from "../../domain/repositories/tenant-key-repository.js";
import { type EncryptedPayload, providerSchema } from "../../security/types.js";
import { router, tenantProcedure } from "../init.js";

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export interface CapabilitiesRouterDeps {
  tenantKeyRepo: TenantKeyRepository;
  encrypt: (plaintext: string, key: Buffer) => unknown;
  deriveTenantKey: (tenantId: string, platformSecret: string) => Buffer;
  platformSecret: string | undefined;
}

let _deps: CapabilitiesRouterDeps | null = null;

export function setCapabilitiesRouterDeps(deps: CapabilitiesRouterDeps): void {
  _deps = deps;
}

function deps(): CapabilitiesRouterDeps {
  if (!_deps) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Capabilities not initialized" });
  return _deps;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const capabilitiesRouter = router({
  /** List all stored API keys for the authenticated tenant (metadata only). */
  listKeys: tenantProcedure.query(async ({ ctx }) => {
    const { tenantKeyRepo } = deps();
    const keys = await tenantKeyRepo.listForTenant(ctx.tenantId);
    return { keys };
  }),

  /** Check whether a key is stored for a specific provider. */
  getKey: tenantProcedure.input(z.object({ provider: providerSchema })).query(async ({ input, ctx }) => {
    const { tenantKeyRepo } = deps();
    const record = await tenantKeyRepo.get(ctx.tenantId, input.provider);
    if (!record) {
      throw new TRPCError({ code: "NOT_FOUND", message: "No key stored for this provider" });
    }
    return {
      id: record.id,
      tenant_id: record.tenantId,
      provider: record.provider,
      label: record.label,
      created_at: record.createdAt,
      updated_at: record.updatedAt,
    };
  }),

  /** Store or replace a tenant API key for a provider. */
  storeKey: tenantProcedure
    .input(
      z.object({
        provider: providerSchema,
        apiKey: z.string().min(1),
        label: z.string().max(100).optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const { tenantKeyRepo, encrypt, deriveTenantKey, platformSecret } = deps();
      if (!platformSecret) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Platform secret not configured" });
      }

      const tenantKey = deriveTenantKey(ctx.tenantId, platformSecret);
      const encryptedPayload = encrypt(input.apiKey, tenantKey);
      const id = await tenantKeyRepo.upsert(
        ctx.tenantId,
        input.provider,
        encryptedPayload as EncryptedPayload,
        input.label ?? "",
      );

      return { ok: true as const, id, provider: input.provider };
    }),

  /** Delete a stored API key. */
  deleteKey: tenantProcedure.input(z.object({ provider: providerSchema })).mutation(async ({ input, ctx }) => {
    const { tenantKeyRepo } = deps();
    const deleted = await tenantKeyRepo.delete(ctx.tenantId, input.provider);
    if (!deleted) {
      throw new TRPCError({ code: "NOT_FOUND", message: "No key stored for this provider" });
    }
    return { ok: true as const, provider: input.provider };
  }),
});
