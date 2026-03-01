/**
 * tRPC credentials router — admin-only CRUD for platform provider API keys.
 *
 * All procedures require platform_admin role (enforced by adminProcedure middleware).
 * Keys are encrypted at rest; plaintext is never returned in list/get operations.
 */

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import type { CredentialVaultStore } from "../../security/credential-vault/index.js";
import { adminProcedure, router } from "../init.js";

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export interface CredentialsRouterDeps {
  getVault: () => CredentialVaultStore;
}

let _deps: CredentialsRouterDeps | null = null;

export function setCredentialsRouterDeps(deps: CredentialsRouterDeps): void {
  _deps = deps;
}

function deps(): CredentialsRouterDeps {
  if (!_deps) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Credentials router not initialized" });
  return _deps;
}

// ---------------------------------------------------------------------------
// Shared schemas
// ---------------------------------------------------------------------------

const providerSchema = z.string().min(1).max(64);
const authTypeSchema = z.enum(["header", "bearer", "basic"]);

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const credentialsRouter = router({
  /** List all credentials, optionally filtered by provider. Never returns encrypted values. */
  list: adminProcedure
    .input(
      z
        .object({
          provider: providerSchema.optional(),
        })
        .optional(),
    )
    .query(({ input }) => {
      const { getVault } = deps();
      return getVault().list(input?.provider);
    }),

  /** Get a single credential by ID. */
  get: adminProcedure.input(z.object({ id: z.string().uuid() })).query(({ input }) => {
    const { getVault } = deps();
    const cred = getVault().getById(input.id);
    if (!cred) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Credential not found" });
    }
    return cred;
  }),

  /** Create a new provider credential. The key is encrypted before storage. */
  create: adminProcedure
    .input(
      z.object({
        provider: providerSchema,
        keyName: z.string().min(1).max(256),
        plaintextKey: z.string().min(1),
        authType: authTypeSchema,
        authHeader: z.string().max(128).optional(),
      }),
    )
    .mutation(({ input, ctx }) => {
      const { getVault } = deps();
      const id = getVault().create({
        provider: input.provider,
        keyName: input.keyName,
        plaintextKey: input.plaintextKey,
        authType: input.authType,
        authHeader: input.authHeader,
        createdBy: ctx.user.id,
      });
      return { id };
    }),

  /** Rotate an existing credential's key. */
  rotate: adminProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        plaintextKey: z.string().min(1),
      }),
    )
    .mutation(({ input, ctx }) => {
      const { getVault } = deps();
      const ok = getVault().rotate({
        id: input.id,
        plaintextKey: input.plaintextKey,
        rotatedBy: ctx.user.id,
      });
      if (!ok) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Credential not found" });
      }
      return { ok: true };
    }),

  /** Activate or deactivate a credential. */
  setActive: adminProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        isActive: z.boolean(),
      }),
    )
    .mutation(({ input, ctx }) => {
      const { getVault } = deps();
      const ok = getVault().setActive(input.id, input.isActive, ctx.user.id);
      if (!ok) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Credential not found" });
      }
      return { ok: true };
    }),

  /** Delete a credential permanently. */
  delete: adminProcedure.input(z.object({ id: z.string().uuid() })).mutation(({ input, ctx }) => {
    const { getVault } = deps();
    const ok = getVault().delete(input.id, ctx.user.id);
    if (!ok) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Credential not found" });
    }
    return { ok: true };
  }),
});
