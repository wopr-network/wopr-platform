/**
 * tRPC capabilities router — BYOK/hosted toggle, key validation.
 *
 * Provides typed procedures for managing tenant API keys
 * and validating provider keys.
 */

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { providerSchema } from "../../security/types.js";
import { router, tenantProcedure } from "../init.js";

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export interface CapabilitiesRouterDeps {
  getTenantKeyStore: () => {
    listForTenant: (tenantId: string) => unknown[];
    get: (
      tenantId: string,
      provider: string,
    ) =>
      | { id: string; tenant_id: string; provider: string; label: string; created_at: number; updated_at: number }
      | undefined;
    upsert: (tenantId: string, provider: string, encryptedPayload: unknown, label: string) => string;
    delete: (tenantId: string, provider: string) => boolean;
  };
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
  listKeys: tenantProcedure.query(({ ctx }) => {
    const { getTenantKeyStore } = deps();
    const keys = getTenantKeyStore().listForTenant(ctx.tenantId);
    return { keys };
  }),

  /** Check whether a key is stored for a specific provider. */
  getKey: tenantProcedure.input(z.object({ provider: providerSchema })).query(({ input, ctx }) => {
    const { getTenantKeyStore } = deps();
    const record = getTenantKeyStore().get(ctx.tenantId, input.provider);
    if (!record) {
      throw new TRPCError({ code: "NOT_FOUND", message: "No key stored for this provider" });
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

  /** Store or replace a tenant API key for a provider. */
  storeKey: tenantProcedure
    .input(
      z.object({
        provider: providerSchema,
        apiKey: z.string().min(1),
        label: z.string().max(100).optional(),
      }),
    )
    .mutation(({ input, ctx }) => {
      const { getTenantKeyStore, encrypt, deriveTenantKey, platformSecret } = deps();
      if (!platformSecret) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Platform secret not configured" });
      }

      const tenantKey = deriveTenantKey(ctx.tenantId, platformSecret);
      const encryptedPayload = encrypt(input.apiKey, tenantKey);
      const id = getTenantKeyStore().upsert(ctx.tenantId, input.provider, encryptedPayload, input.label ?? "");

      return { ok: true as const, id, provider: input.provider };
    }),

  /** Delete a stored API key. */
  deleteKey: tenantProcedure.input(z.object({ provider: providerSchema })).mutation(({ input, ctx }) => {
    const { getTenantKeyStore } = deps();
    const deleted = getTenantKeyStore().delete(ctx.tenantId, input.provider);
    if (!deleted) {
      throw new TRPCError({ code: "NOT_FOUND", message: "No key stored for this provider" });
    }
    return { ok: true as const, provider: input.provider };
  }),
});
