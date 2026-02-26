import { Hono } from "hono";
import type { IAdminNotesRepository } from "../../admin/notes/admin-notes-repository.js";
import { AdminNotesStore } from "../../admin/notes/store.js";
import type { AuthEnv } from "../../auth/index.js";
import { buildTokenMetadataMap, scopedBearerAuthWithTenant } from "../../auth/index.js";
import type { DrizzleDb } from "../../db/index.js";
import { getAdminAuditLog, getDb } from "../../fleet/services.js";

const metadataMap = buildTokenMetadataMap();
const adminAuth = scopedBearerAuthWithTenant(metadataMap, "admin");

export interface AdminNotesRouteDeps {
  db: DrizzleDb;
}

let _notesStore: IAdminNotesRepository | null = null;

/** Override the store (used in tests or for explicit wiring). */
export function setAdminNotesDeps(deps: AdminNotesRouteDeps): void {
  _notesStore = new AdminNotesStore(deps.db);
}

/** Lazily initialize from the platform DB on first request. */
function getNotesStore(): IAdminNotesRepository {
  if (!_notesStore) {
    _notesStore = new AdminNotesStore(getDb());
  }
  return _notesStore;
}

function parseIntParam(value: string | undefined): number | undefined {
  if (value == null) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** Factory for tests -- inject an in-memory DB. */
export function createAdminNotesApiRoutes(db: DrizzleDb): Hono<AuthEnv> {
  const store = new AdminNotesStore(db);
  return buildRoutes(() => store);
}

function buildRoutes(storeFactory: () => IAdminNotesRepository): Hono<AuthEnv> {
  const routes = new Hono<AuthEnv>();

  // GET /:tenantId -- list notes
  routes.get("/:tenantId", async (c) => {
    const store = storeFactory();
    const tenantId = c.req.param("tenantId");
    const filters = {
      tenantId,
      limit: parseIntParam(c.req.query("limit")),
      offset: parseIntParam(c.req.query("offset")),
    };
    try {
      const result = await store.list(filters);
      return c.json(result);
    } catch {
      return c.json({ error: "Internal server error" }, 500);
    }
  });

  // POST /:tenantId -- create note
  routes.post("/:tenantId", async (c) => {
    const store = storeFactory();
    const tenantId = c.req.param("tenantId");
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
    try {
      const user = c.get("user");
      const note = await store.create({
        tenantId,
        authorId: user?.id ?? "unknown",
        content,
        isPinned: body.isPinned === true,
      });
      try {
        void getAdminAuditLog().log({
          adminUser: user?.id ?? "unknown",
          action: "note.create",
          category: "support",
          targetTenant: tenantId,
          details: { noteId: note.id },
          outcome: "success",
        });
      } catch {
        /* audit must not break request */
      }
      return c.json(note, 201);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Internal server error" }, 500);
    }
  });

  // PATCH /:tenantId/:noteId -- update note
  routes.patch("/:tenantId/:noteId", async (c) => {
    const store = storeFactory();
    const tenantId = c.req.param("tenantId");
    const noteId = c.req.param("noteId");
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const updates: { content?: string; isPinned?: boolean } = {};
    if (typeof body.content === "string") updates.content = body.content;
    if (typeof body.isPinned === "boolean") updates.isPinned = body.isPinned;
    try {
      const note = await store.update(noteId, tenantId, updates);
      if (note === null) {
        // Could be not found or ownership mismatch — return 403 to avoid leaking note existence
        return c.json({ error: "Forbidden" }, 403);
      }
      try {
        const user = c.get("user");
        void getAdminAuditLog().log({
          adminUser: user?.id ?? "unknown",
          action: "note.update",
          category: "support",
          targetTenant: tenantId,
          details: { noteId, hasContentChange: !!updates.content, hasPinChange: updates.isPinned !== undefined },
          outcome: "success",
        });
      } catch {
        /* audit must not break request */
      }
      return c.json(note);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Internal server error" }, 500);
    }
  });

  // DELETE /:tenantId/:noteId -- delete note
  routes.delete("/:tenantId/:noteId", async (c) => {
    const store = storeFactory();
    const tenantId = c.req.param("tenantId");
    const noteId = c.req.param("noteId");
    try {
      const deleted = await store.delete(noteId, tenantId);
      if (!deleted) return c.json({ error: "Forbidden" }, 403);
      try {
        const user = c.get("user");
        void getAdminAuditLog().log({
          adminUser: user?.id ?? "unknown",
          action: "note.delete",
          category: "support",
          targetTenant: tenantId,
          details: { noteId },
          outcome: "success",
        });
      } catch {
        /* audit must not break request */
      }
      return c.json({ ok: true });
    } catch {
      return c.json({ error: "Internal server error" }, 500);
    }
  });

  return routes;
}

/** Pre-built admin notes routes with auth. */
export const adminNotesRoutes = new Hono<AuthEnv>();
adminNotesRoutes.use("*", adminAuth);
adminNotesRoutes.route("/", buildRoutes(getNotesStore));
