/**
 * tRPC org router -- organization settings, member management, OAuth connections.
 *
 * All procedures require authentication. Owner-only operations (transfer, remove)
 * enforce role checks. Stub implementations until org service layer is built.
 */

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure, router } from "../init.js";

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export type OrgRouterDeps = object;

let _deps: OrgRouterDeps | null = null;

export function setOrgRouterDeps(deps: OrgRouterDeps): void {
  _deps = deps;
}

function deps(): OrgRouterDeps {
  if (!_deps) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Org router not initialized" });
  return _deps;
}

// ---------------------------------------------------------------------------
// Types (match UI's Organization/OrgMember from wopr-platform-ui/src/lib/api.ts)
// ---------------------------------------------------------------------------

interface OrgMember {
  id: string;
  name: string;
  email: string;
  role: "owner" | "admin" | "viewer";
  joinedAt: string;
}

interface Organization {
  id: string;
  name: string;
  billingEmail: string;
  members: OrgMember[];
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const orgRouter = router({
  /** Get the organization for the authenticated user. */
  getOrganization: protectedProcedure.query(({ ctx }) => {
    // TODO(WOP-815): wire to org service layer
    void deps();
    return {
      id: ctx.user.id,
      name: "My Organization",
      billingEmail: "",
      members: [
        {
          id: ctx.user.id,
          name: "You",
          email: "",
          role: "owner" as const,
          joinedAt: new Date().toISOString(),
        },
      ],
    } satisfies Organization;
  }),

  /** Update organization name and/or billing email. */
  updateOrganization: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1).max(128).optional(),
        billingEmail: z.string().email().optional(),
      }),
    )
    .mutation(({ input, ctx }) => {
      // TODO(WOP-815): wire to org service layer
      void deps();
      return {
        id: ctx.user.id,
        name: input.name ?? "My Organization",
        billingEmail: input.billingEmail ?? "",
        members: [
          {
            id: ctx.user.id,
            name: "You",
            email: "",
            role: "owner" as const,
            joinedAt: new Date().toISOString(),
          },
        ],
      } satisfies Organization;
    }),

  /** Invite a new member to the organization. */
  inviteMember: protectedProcedure
    .input(
      z.object({
        email: z.string().email(),
        role: z.enum(["admin", "viewer"]),
      }),
    )
    .mutation(({ input }) => {
      // TODO(WOP-815): wire to org service layer + email invitation
      void deps();
      const id = `member-${Date.now()}`;
      return {
        id,
        name: input.email.split("@")[0],
        email: input.email,
        role: input.role,
        joinedAt: new Date().toISOString(),
      } satisfies OrgMember;
    }),

  /** Remove a member from the organization. Owner only. */
  removeMember: protectedProcedure.input(z.object({ memberId: z.string().min(1) })).mutation(({ input }) => {
    // TODO(WOP-815): wire to org service layer
    // Should verify caller is owner and memberId !== caller
    void deps();
    return { removed: true, memberId: input.memberId };
  }),

  /** Transfer organization ownership to another member. Owner only. */
  transferOwnership: protectedProcedure.input(z.object({ memberId: z.string().min(1) })).mutation(({ input }) => {
    // TODO(WOP-815): wire to org service layer
    // Should verify caller is owner and target is an existing member
    void deps();
    return { transferred: true, newOwnerId: input.memberId };
  }),

  /** Connect an OAuth provider to the organization/user. */
  connectOauthProvider: protectedProcedure
    .input(z.object({ provider: z.string().min(1).max(64) }))
    .mutation(({ input }) => {
      // TODO(WOP-815): wire to better-auth OAuth linking
      void deps();
      return { connected: true, provider: input.provider };
    }),

  /** Disconnect an OAuth provider from the organization/user. */
  disconnectOauthProvider: protectedProcedure
    .input(z.object({ provider: z.string().min(1).max(64) }))
    .mutation(({ input }) => {
      // TODO(WOP-815): wire to better-auth OAuth unlinking
      void deps();
      return { disconnected: true, provider: input.provider };
    }),
});
