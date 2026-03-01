/**
 * tRPC org router -- organization settings, member management, OAuth connections.
 *
 * All procedures require authentication.
 */

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import type { IAuthUserRepository } from "../../db/auth-user-repository.js";
import type { OrgService } from "../../org/org-service.js";
import { protectedProcedure, router } from "../init.js";

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export type OrgRouterDeps = {
  orgService: OrgService;
  authUserRepo: IAuthUserRepository;
};

let _deps: OrgRouterDeps | null = null;

/**
 * Wire org-router dependencies at application startup (e.g. in the server
 * entry point before any request is served).  If this is not called before
 * a procedure executes, every call will throw INTERNAL_SERVER_ERROR.
 */
export function setOrgRouterDeps(deps: OrgRouterDeps): void {
  _deps = deps;
}

function deps(): OrgRouterDeps {
  if (!_deps) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Org router not initialized" });
  return _deps;
}

const SUPPORTED_OAUTH_PROVIDERS = new Set(["github", "discord", "google"]);

function getOauthConnectUrl(provider: string): string {
  const baseUrl = process.env.BETTER_AUTH_URL || "http://localhost:3100";
  const callbackUrl = process.env.UI_ORIGIN || "http://localhost:3001";
  return `${baseUrl}/api/auth/sign-in/social?provider=${encodeURIComponent(provider)}&callbackURL=${encodeURIComponent(callbackUrl)}/settings`;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const orgRouter = router({
  /** Get the organization for the authenticated user (personal tenant). */
  getOrganization: protectedProcedure.query(async ({ ctx }) => {
    const { orgService } = deps();
    const name = ("name" in ctx.user ? (ctx.user.name as string | undefined) : undefined) ?? "User";
    const email = ("email" in ctx.user ? (ctx.user.email as string | undefined) : undefined) ?? "";
    const org = await orgService.getOrCreatePersonalOrg(ctx.user.id, name);
    // Enrich member rows with the current user's name/email when they match
    const members = org.members.map((m) => {
      if (m.userId === ctx.user.id) {
        return { ...m, name, email };
      }
      return m;
    });
    return { ...org, members };
  }),

  /** Update organization name and/or slug. */
  updateOrganization: protectedProcedure
    .input(
      z.object({
        orgId: z.string().min(1),
        name: z.string().min(1).max(128).optional(),
        slug: z.string().min(3).max(48).optional(),
        billingEmail: z.string().email().max(255).optional().nullable(),
      }),
    )
    .mutation(({ input, ctx }) => {
      const { orgService } = deps();
      return orgService.updateOrg(input.orgId, ctx.user.id, {
        name: input.name,
        slug: input.slug,
        billingEmail: input.billingEmail,
      });
    }),

  /** Delete an organization. Owner only. */
  deleteOrganization: protectedProcedure
    .input(z.object({ orgId: z.string().min(1) }))
    .mutation(async ({ input, ctx }) => {
      const { orgService } = deps();
      await orgService.deleteOrg(input.orgId, ctx.user.id);
      return { deleted: true };
    }),

  /** Invite a new member to the organization. */
  inviteMember: protectedProcedure
    .input(
      z.object({
        orgId: z.string().min(1),
        email: z.string().email(),
        role: z.enum(["admin", "member"]),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const { orgService } = deps();
      const invite = await orgService.inviteMember(input.orgId, ctx.user.id, input.email, input.role);
      return {
        id: invite.id,
        email: invite.email,
        role: invite.role,
        invitedBy: invite.invitedBy,
        expiresAt: new Date(invite.expiresAt).toISOString(),
        createdAt: new Date(invite.createdAt).toISOString(),
      };
    }),

  /** Revoke a pending invite. Admin or owner only. */
  revokeInvite: protectedProcedure
    .input(z.object({ orgId: z.string().min(1), inviteId: z.string().min(1) }))
    .mutation(async ({ input, ctx }) => {
      const { orgService } = deps();
      await orgService.revokeInvite(input.orgId, ctx.user.id, input.inviteId);
      return { revoked: true };
    }),

  /** Change a member's role (admin/member only — not owner). */
  changeRole: protectedProcedure
    .input(
      z.object({
        orgId: z.string().min(1),
        userId: z.string().min(1),
        role: z.enum(["admin", "member"]),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const { orgService } = deps();
      await orgService.changeRole(input.orgId, ctx.user.id, input.userId, input.role);
      return { updated: true };
    }),

  /** Remove a member from the organization. Admin or owner only. */
  removeMember: protectedProcedure
    .input(z.object({ orgId: z.string().min(1), userId: z.string().min(1) }))
    .mutation(async ({ input, ctx }) => {
      const { orgService } = deps();
      await orgService.removeMember(input.orgId, ctx.user.id, input.userId);
      return { removed: true };
    }),

  /** Transfer organization ownership to another member. Owner only. */
  transferOwnership: protectedProcedure
    .input(z.object({ orgId: z.string().min(1), userId: z.string().min(1) }))
    .mutation(async ({ input, ctx }) => {
      const { orgService } = deps();
      await orgService.transferOwnership(input.orgId, ctx.user.id, input.userId);
      return { transferred: true };
    }),

  /** Connect an OAuth provider — returns the Better Auth OAuth URL for the UI to redirect to. */
  connectOauthProvider: protectedProcedure
    .input(z.object({ provider: z.string().min(1).max(64) }))
    .mutation(({ input }) => {
      deps();
      if (!SUPPORTED_OAUTH_PROVIDERS.has(input.provider)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Unsupported OAuth provider: ${input.provider}. Supported: ${[...SUPPORTED_OAUTH_PROVIDERS].join(", ")}`,
        });
      }
      return { url: getOauthConnectUrl(input.provider), provider: input.provider };
    }),

  /** Disconnect an OAuth provider from the authenticated user. */
  disconnectOauthProvider: protectedProcedure
    .input(z.object({ provider: z.string().min(1).max(64) }))
    .mutation(async ({ input, ctx }) => {
      const { authUserRepo } = deps();
      const accounts = await authUserRepo.listAccounts(ctx.user.id);
      const hasProvider = accounts.some((a) => a.providerId === input.provider);
      if (!hasProvider) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `OAuth provider "${input.provider}" is not linked to your account`,
        });
      }
      // Prevent lockout: must have at least one other account after unlinking
      if (accounts.length <= 1) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Cannot disconnect your only authentication method. Add another login method first.",
        });
      }
      const removed = await authUserRepo.unlinkAccount(ctx.user.id, input.provider);
      if (!removed) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Failed to disconnect provider" });
      }
      return { disconnected: true, provider: input.provider };
    }),
});
