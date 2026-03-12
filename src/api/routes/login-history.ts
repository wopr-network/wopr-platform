import type { AuthEnv } from "@wopr-network/platform-core/auth";
import type { ILoginHistoryRepository } from "@wopr-network/platform-core/auth/login-history-repository";
import { Hono } from "hono";

let _repoOverride: ILoginHistoryRepository | null = null;
let _repoFactory: (() => ILoginHistoryRepository) | null = null;

/** Inject a test repo (pass null to reset). */
export function setLoginHistoryRepo(repo: ILoginHistoryRepository | null): void {
  _repoOverride = repo;
}

/** Set the production repo factory (called from index.ts). */
export function setLoginHistoryRepoFactory(factory: () => ILoginHistoryRepository): void {
  _repoFactory = factory;
}

function resolveRepo(): ILoginHistoryRepository {
  if (_repoOverride) return _repoOverride;
  if (_repoFactory) return _repoFactory();
  throw new Error("Login history repository not configured");
}

export const loginHistoryRoutes = new Hono<AuthEnv>();

/**
 * GET /
 *
 * Returns recent login sessions for the authenticated user.
 * Query params:
 *   - limit: max results (default 20, max 100)
 */
loginHistoryRoutes.get("/", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const limitRaw = c.req.query("limit");
  const limit = limitRaw ? Math.min(Math.max(1, Number.parseInt(limitRaw, 10) || 20), 100) : 20;

  const repo = resolveRepo();
  const entries = await repo.findByUserId(user.id, limit);
  return c.json(entries);
});
