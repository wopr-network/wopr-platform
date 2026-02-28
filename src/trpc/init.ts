/**
 * tRPC initialization — creates the base router and procedure builders.
 *
 * Context carries the authenticated user (if any) and the tenant ID
 * extracted from the bearer token or session.
 */

import { initTRPC, TRPCError } from "@trpc/server";
import type { AuthUser } from "../auth/index.js";
import { validateTenantAccess } from "../auth/index.js";
import type { IOrgMemberRepository } from "../fleet/org-member-repository.js";

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface TRPCContext {
  /** Authenticated user, or undefined for unauthenticated requests. */
  user: AuthUser | undefined;
  /** Tenant ID associated with the bearer token, if any. */
  tenantId: string | undefined;
}

// ---------------------------------------------------------------------------
// tRPC init
// ---------------------------------------------------------------------------

const t = initTRPC.context<TRPCContext>().create();

// ---------------------------------------------------------------------------
// Org member repo injection (for tenant access validation)
// ---------------------------------------------------------------------------

let _orgMemberRepo: IOrgMemberRepository | null = null;

/** Wire the org member repository for tRPC tenant validation. Called from services.ts on startup. */
export function setTrpcOrgMemberRepo(repo: IOrgMemberRepository): void {
  _orgMemberRepo = repo;
}

export const router = t.router;
export const publicProcedure = t.procedure;

/**
 * Middleware that enforces authentication.
 * Narrows context so downstream resolvers get a non-optional `user`.
 */
const isAuthed = t.middleware(({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Authentication required" });
  }
  return next({ ctx: { user: ctx.user, tenantId: ctx.tenantId } });
});

/** Procedure that requires a valid authenticated user. */
export const protectedProcedure = t.procedure.use(isAuthed);

/**
 * Middleware that enforces the platform_admin role.
 * Must be chained after isAuthed so ctx.user is guaranteed non-optional.
 */
const isAdmin = t.middleware(({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Authentication required" });
  }
  if (!ctx.user.roles.includes("platform_admin")) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Platform admin role required" });
  }
  return next({ ctx: { user: ctx.user, tenantId: ctx.tenantId } });
});

/** Procedure that requires authentication + platform_admin role. */
export const adminProcedure = t.procedure.use(isAuthed).use(isAdmin);

/**
 * Combined middleware that enforces authentication + tenant context.
 * Narrows both `user` (non-optional) and `tenantId` (non-optional string).
 * Also validates that session-cookie users have access to the claimed tenant (IDOR prevention).
 */
const isAuthedWithTenant = t.middleware(async ({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Authentication required" });
  }
  if (!ctx.tenantId) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Tenant context required" });
  }

  // Validate tenant access for session-cookie users (bearer token users have server-assigned tenantId).
  // Skip if the org member repo is not yet wired (e.g., test environment without DI).
  if (!ctx.user.id.startsWith("token:") && _orgMemberRepo) {
    const allowed = await validateTenantAccess(ctx.user.id, ctx.tenantId, _orgMemberRepo);
    if (!allowed) {
      throw new TRPCError({ code: "FORBIDDEN", message: "Not authorized for this tenant" });
    }
  }

  return next({ ctx: { user: ctx.user, tenantId: ctx.tenantId } });
});

/** Procedure that requires authentication + a tenant context. */
export const tenantProcedure = t.procedure.use(isAuthedWithTenant);
