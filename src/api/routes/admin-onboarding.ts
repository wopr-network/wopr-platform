import { Hono } from "hono";
import type { AuthEnv } from "../../auth/index.js";
import { buildTokenMetadataMap, scopedBearerAuthWithTenant } from "../../auth/index.js";
import type { IOnboardingScriptRepository } from "../../onboarding/onboarding-script-repository.js";

type RepoFactory = () => IOnboardingScriptRepository;

export function createAdminOnboardingRoutes(getRepo: RepoFactory): Hono<AuthEnv> {
  const routes = new Hono<AuthEnv>();

  routes.get("/current", async (c) => {
    const repo = getRepo();
    const script = await repo.findCurrent();
    if (!script) {
      return c.json({ error: "No onboarding script found" }, 404);
    }
    return c.json(script);
  });

  routes.get("/history", async (c) => {
    const repo = getRepo();
    const limitParam = c.req.query("limit");
    const limit = limitParam ? Math.min(50, Math.max(1, Number(limitParam) || 10)) : 10;
    const history = await repo.findHistory(limit);
    return c.json(history);
  });

  routes.post("/", async (c) => {
    const repo = getRepo();
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const content = body.content;
    if (typeof content !== "string" || !content.trim()) {
      return c.json({ error: "content is required and must be non-empty" }, 400);
    }

    const user = c.get("user");
    const script = await repo.insert({
      content,
      updatedBy: user?.id ?? null,
    });

    return c.json(script, 201);
  });

  return routes;
}

export function mountAdminOnboardingRoutes(getRepo: RepoFactory): Hono<AuthEnv> {
  const metadataMap = buildTokenMetadataMap();
  const adminAuth = scopedBearerAuthWithTenant(metadataMap, "admin");
  const wrapper = new Hono<AuthEnv>();
  wrapper.use("*", adminAuth);
  wrapper.route("/", createAdminOnboardingRoutes(getRepo));
  return wrapper;
}
