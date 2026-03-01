import { TRPCError } from "@trpc/server";
import { Hono } from "hono";
import type { RoleStore } from "../../admin/roles/role-store.js";
import type { AuthEnv } from "../../auth/index.js";
import type { IOrgRepository } from "../../org/drizzle-org-repository.js";

export interface OrgRouteDeps {
  orgRepo: IOrgRepository;
  roleStore: RoleStore;
}

export function createOrgRoutes(deps: OrgRouteDeps | (() => OrgRouteDeps)): Hono<AuthEnv> {
  const getDeps = typeof deps === "function" ? deps : () => deps;
  const routes = new Hono<AuthEnv>();

  // POST /api/orgs — create a new org
  routes.post("/", async (c) => {
    const { orgRepo, roleStore } = getDeps();
    const user = c.get("user");
    if (!user) {
      return c.json({ error: "Authentication required" }, 401);
    }

    const body = await c.req.json<{ name?: string; slug?: string }>().catch(() => null);
    if (!body?.name || typeof body.name !== "string" || !body.name.trim()) {
      return c.json({ error: "name is required" }, 400);
    }

    const name = body.name.trim();
    const slug = body.slug?.trim() || undefined;

    try {
      const org = await orgRepo.createOrg(user.id, name, slug);
      // Assign creator as tenant_admin
      await roleStore.setRole(user.id, org.id, "tenant_admin", user.id);
      return c.json({ id: org.id, name: org.name, slug: org.slug, type: org.type }, 201);
    } catch (err: unknown) {
      if (err instanceof Error && (err as { status?: number }).status === 400) {
        return c.json({ error: err.message }, 400);
      }
      // Repository throws TRPCError CONFLICT for duplicate slug
      if (err instanceof TRPCError && err.code === "CONFLICT") {
        return c.json({ error: "An org with this slug already exists" }, 409);
      }
      // PostgreSQL or SQLite UNIQUE constraint violation (fallback)
      const cause = err instanceof Error ? (err.cause as Error | undefined) : undefined;
      const causeMsg = cause?.message ?? "";
      const causeCode = (cause as { code?: string } | undefined)?.code;
      if (
        err instanceof Error &&
        (err.message.includes("UNIQUE constraint failed") ||
          err.message.includes("duplicate key value") ||
          (err as { code?: string }).code === "23505" ||
          causeMsg.includes("duplicate key value") ||
          causeCode === "23505")
      ) {
        return c.json({ error: "An org with this slug already exists" }, 409);
      }
      throw err;
    }
  });

  // GET /api/orgs — list orgs the current user owns
  routes.get("/", async (c) => {
    const { orgRepo } = getDeps();
    const user = c.get("user");
    if (!user) {
      return c.json({ error: "Authentication required" }, 401);
    }

    const orgs = await orgRepo.listOrgsByOwner(user.id);
    return c.json({
      orgs: orgs.map((o) => ({ id: o.id, name: o.name, slug: o.slug, type: o.type })),
    });
  });

  return routes;
}
