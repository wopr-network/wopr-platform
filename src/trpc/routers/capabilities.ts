/**
 * tRPC capabilities router — BYOK/hosted toggle, key validation.
 *
 * Provides typed procedures for managing tenant API keys
 * and validating provider keys.
 */

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  ALL_CAPABILITIES,
  type CapabilitySettingsStore,
} from "../../security/tenant-keys/capability-settings-store.js";
import type { EncryptedPayload } from "../../security/types.js";
import { providerSchema } from "../../security/types.js";
import { router, tenantProcedure } from "../init.js";

// ---------------------------------------------------------------------------
// Capability metadata
// ---------------------------------------------------------------------------

/** Capabilities that only support hosted mode (no BYOK). */
const HOSTED_ONLY_CAPABILITIES = new Set(["transcription", "image-gen"]);

/** Maps a capability to the provider whose key it uses (for BYOK). */
const CAPABILITY_PROVIDER: Record<string, string> = {
  "text-gen": "openai",
  embeddings: "openai",
};

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
      | {
          id: string;
          tenant_id: string;
          provider: string;
          label: string;
          created_at: number;
          updated_at: number;
        }
      | undefined;
    upsert: (tenantId: string, provider: string, encryptedPayload: EncryptedPayload, label: string) => string;
    delete: (tenantId: string, provider: string) => boolean;
  };
  getCapabilitySettingsStore: () => CapabilitySettingsStore;
  encrypt: (plaintext: string, key: Buffer) => EncryptedPayload;
  deriveTenantKey: (tenantId: string, platformSecret: string) => Buffer;
  platformSecret: string | undefined;
  /** Validate a provider API key by calling the provider's API server-side. */
  validateProviderKey: (provider: string, key: string) => Promise<{ valid: boolean; error?: string }>;
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
// Capability-to-provider mapping
// ---------------------------------------------------------------------------

const CAPABILITY_BYOK_PROVIDER: Record<string, string | null> = {
  transcription: null,
  "image-gen": null,
  "text-gen": "openai",
  embeddings: "openai",
};

const capabilityNameSchema = z.enum(["transcription", "image-gen", "text-gen", "embeddings"]);
const capabilityModeSchema = z.enum(["hosted", "byok"]);

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
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Platform secret not configured",
        });
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

  /** Validate a provider API key by calling the provider's API server-side. */
  testKey: tenantProcedure
    .input(z.object({ provider: providerSchema, key: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const { validateProviderKey } = deps();
      try {
        return await validateProviderKey(input.provider, input.key);
      } catch {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Failed to validate key" });
      }
    }),

  /** List capability settings for the authenticated tenant. */
  listCapabilitySettings: tenantProcedure.query(({ ctx }) => {
    const { getTenantKeyStore, getCapabilitySettingsStore } = deps();
    const keyStore = getTenantKeyStore();
    const capStore = getCapabilitySettingsStore();
    const settings = capStore.listForTenant(ctx.tenantId);
    const settingsMap = new Map(settings.map((s) => [s.capability, s.mode]));

    return ALL_CAPABILITIES.map((capability) => {
      const mode = settingsMap.get(capability) ?? "hosted";
      const provider = CAPABILITY_PROVIDER[capability] ?? null;
      const hostedOnly = HOSTED_ONLY_CAPABILITIES.has(capability);

      if (mode === "hosted" || hostedOnly) {
        return {
          capability,
          mode: "hosted" as const,
          provider: hostedOnly ? null : provider,
          maskedKey: null,
          keyStatus: null,
        };
      }

      // byok mode
      const keyRecord = provider ? keyStore.get(ctx.tenantId, provider) : undefined;
      return {
        capability,
        mode: "byok" as const,
        provider,
        maskedKey: keyRecord ? (keyRecord as { label: string }).label : null,
        keyStatus: keyRecord ? ("unchecked" as const) : null,
      };
    });
  }),

  /** Update capability mode (hosted vs byok) and optionally store a new key. */
  updateCapabilitySettings: tenantProcedure
    .input(
      z.object({
        capability: z.enum(ALL_CAPABILITIES),
        mode: z.enum(["hosted", "byok"]),
        key: z.string().min(1).optional(),
      }),
    )
    .mutation(({ input, ctx }) => {
      const { getTenantKeyStore, getCapabilitySettingsStore, encrypt, deriveTenantKey, platformSecret } = deps();

      if (input.mode === "byok" && HOSTED_ONLY_CAPABILITIES.has(input.capability)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `${input.capability} does not support BYOK mode`,
        });
      }

      const capStore = getCapabilitySettingsStore();
      capStore.upsert(ctx.tenantId, input.capability, input.mode);

      if (input.mode === "hosted") {
        return {
          capability: input.capability,
          mode: "hosted" as const,
          provider: null,
          maskedKey: null,
          keyStatus: null,
        };
      }

      const provider = CAPABILITY_PROVIDER[input.capability] ?? null;
      const keyStore = getTenantKeyStore();

      if (input.key && provider) {
        if (!platformSecret) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Platform secret not configured",
          });
        }
        const tenantKey = deriveTenantKey(ctx.tenantId, platformSecret);
        const encryptedPayload = encrypt(input.key, tenantKey);
        const maskedKey = `...${input.key.slice(-4)}`;
        keyStore.upsert(ctx.tenantId, provider, encryptedPayload, maskedKey);
        return {
          capability: input.capability,
          mode: "byok" as const,
          provider,
          maskedKey,
          keyStatus: "unchecked" as const,
        };
      }

      const keyRecord = provider ? keyStore.get(ctx.tenantId, provider) : undefined;
      return {
        capability: input.capability,
        mode: "byok" as const,
        provider,
        maskedKey: keyRecord ? (keyRecord as { label: string }).label : null,
        keyStatus: keyRecord ? ("unchecked" as const) : null,
      };
    }),
});
