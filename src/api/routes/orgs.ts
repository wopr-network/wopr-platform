import { Hono } from "hono";
import type { RoleStore } from "../../admin/roles/role-store.js";
import type { AuthEnv } from "../../auth/index.js";
import type { IOrgRepository } from "../../org/org-repository.js";

export interface OrgRouteDeps {
  orgRepo: IOrgRepository;
  roleStore: RoleStore;
}

export function createOrgRoutes(deps: OrgRouteDeps): Hono<AuthEnv> {
  const { orgRepo, roleStore } = deps;
  const routes = new Hono<AuthEnv>();

  // POST /api/orgs — create a new org
  routes.post("/", async (c) => {
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
      const org = orgRepo.createOrg(user.id, name, slug);
      // Assign creator as tenant_admin
      roleStore.setRole(user.id, org.id, "tenant_admin", user.id);
      return c.json({ id: org.id, name: org.name, slug: org.slug, type: org.type }, 201);
    } catch (err: unknown) {
      // SQLite UNIQUE constraint violation
      if (err instanceof Error && err.message.includes("UNIQUE constraint failed")) {
        return c.json({ error: "An org with this slug already exists" }, 409);
      }
      throw err;
    }
  });

  // GET /api/orgs — list orgs the current user owns
  routes.get("/", (c) => {
    const user = c.get("user");
    if (!user) {
      return c.json({ error: "Authentication required" }, 401);
    }

    const orgs = orgRepo.listOrgsByOwner(user.id);
    return c.json({
      orgs: orgs.map((o) => ({ id: o.id, name: o.name, slug: o.slug, type: o.type })),
    });
  });

  return routes;
}
