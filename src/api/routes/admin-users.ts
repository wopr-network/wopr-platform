import type Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { Hono } from "hono";
import { initAdminUsersSchema } from "../../admin/users/schema.js";
import type { AuthEnv } from "../../auth/index.js";
import { buildTokenMetadataMap, scopedBearerAuthWithTenant } from "../../auth/index.js";
import * as dbSchema from "../../db/schema/index.js";
import type { AdminUserFilters, AdminUserRepository } from "../../domain/repositories/admin-user-repository.js";
import { DrizzleAdminUserRepository } from "../../infrastructure/persistence/drizzle-admin-user-repository.js";

// ---------------------------------------------------------------------------
// Deps / lazy init
// ---------------------------------------------------------------------------

const metadataMap = buildTokenMetadataMap();
const adminAuth = scopedBearerAuthWithTenant(metadataMap, "admin");

export interface AdminUsersRouteDeps {
  db: Database.Database;
}

let _userRepo: AdminUserRepository | null = null;

/** Set dependencies for admin user routes. */
export function setAdminUsersDeps(deps: AdminUsersRouteDeps): void {
  initAdminUsersSchema(deps.db);
  const drizzleDb = drizzle(deps.db, { schema: dbSchema });
  _userRepo = new DrizzleAdminUserRepository(drizzleDb);
}

function getUserRepo(): AdminUserRepository {
  if (!_userRepo) {
    throw new Error("Admin user routes not initialized -- call setAdminUsersDeps() first");
  }
  return _userRepo;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseIntParam(value: string | undefined): number | undefined {
  if (value == null) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function parseBoolParam(value: string | undefined): boolean | undefined {
  if (value == null) return undefined;
  return value === "true" || value === "1";
}

const VALID_STATUSES = new Set(["active", "suspended", "grace_period", "dormant"]);
const VALID_ROLES = new Set(["platform_admin", "tenant_admin", "user"]);
const VALID_SORT_BY = new Set(["last_seen", "created_at", "balance", "agent_count"]);
const VALID_SORT_ORDER = new Set(["asc", "desc"]);

// ---------------------------------------------------------------------------
// Factory (for tests)
// ---------------------------------------------------------------------------

/**
 * Create admin user API routes with an explicit database.
 * Used in tests to inject an in-memory database.
 */
export function createAdminUsersApiRoutes(db: Database.Database): Hono<AuthEnv> {
  const drizzleDb = drizzle(db, { schema: dbSchema });
  const userRepo = new DrizzleAdminUserRepository(drizzleDb);
  const routes = new Hono<AuthEnv>();

  routes.get("/", async (c) => {
    const filters = buildFilters(c);
    try {
      const result = await userRepo.list(filters);
      return c.json(result);
    } catch {
      return c.json({ error: "Internal server error" }, 500);
    }
  });

  routes.get("/:userId", async (c) => {
    const userId = c.req.param("userId");
    try {
      const user = await userRepo.getById(userId);
      if (!user) {
        return c.json({ error: "User not found" }, 404);
      }
      return c.json(user);
    } catch {
      return c.json({ error: "Internal server error" }, 500);
    }
  });

  return routes;
}

// ---------------------------------------------------------------------------
// Pre-built routes with auth
// ---------------------------------------------------------------------------

export const adminUsersApiRoutes = new Hono<AuthEnv>();

adminUsersApiRoutes.use("*", adminAuth);

adminUsersApiRoutes.get("/", async (c) => {
  const repo = getUserRepo();
  const filters = buildFilters(c);
  try {
    const result = await repo.list(filters);
    return c.json(result);
  } catch {
    return c.json({ error: "Internal server error" }, 500);
  }
});

adminUsersApiRoutes.get("/:userId", async (c) => {
  const repo = getUserRepo();
  const userId = c.req.param("userId");
  try {
    const user = await repo.getById(userId);
    if (!user) {
      return c.json({ error: "User not found" }, 404);
    }
    return c.json(user);
  } catch {
    return c.json({ error: "Internal server error" }, 500);
  }
});

// ---------------------------------------------------------------------------
// Shared filter builder
// ---------------------------------------------------------------------------

function buildFilters(c: { req: { query: (key: string) => string | undefined } }): AdminUserFilters {
  const statusRaw = c.req.query("status");
  const roleRaw = c.req.query("role");
  const sortByRaw = c.req.query("sortBy");
  const sortOrderRaw = c.req.query("sortOrder");

  return {
    search: c.req.query("search") ?? undefined,
    status: statusRaw && VALID_STATUSES.has(statusRaw) ? (statusRaw as AdminUserFilters["status"]) : undefined,
    role: roleRaw && VALID_ROLES.has(roleRaw) ? (roleRaw as AdminUserFilters["role"]) : undefined,
    hasCredits: parseBoolParam(c.req.query("hasCredits")),
    lowBalance: parseBoolParam(c.req.query("lowBalance")),
    sortBy: sortByRaw && VALID_SORT_BY.has(sortByRaw) ? (sortByRaw as AdminUserFilters["sortBy"]) : undefined,
    sortOrder:
      sortOrderRaw && VALID_SORT_ORDER.has(sortOrderRaw) ? (sortOrderRaw as AdminUserFilters["sortOrder"]) : undefined,
    limit: parseIntParam(c.req.query("limit")),
    offset: parseIntParam(c.req.query("offset")),
  };
}
