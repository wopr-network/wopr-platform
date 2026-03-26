import { createAdminNotesApiRoutes as _create } from "@wopr-network/platform-core/api/routes/admin-notes";
import type { AuthEnv } from "@wopr-network/platform-core/auth";
import { buildTokenMetadataMap, scopedBearerAuthWithTenant } from "@wopr-network/platform-core/auth";
import type { DrizzleDb } from "@wopr-network/platform-core/db/index";
import { getDb } from "@wopr-network/platform-core/fleet/services";
import { Hono } from "hono";
import type { IAdminNotesRepository } from "../../admin/notes/admin-notes-repository.js";
import { AdminNotesStore } from "../../admin/notes/store.js";
import { getAdminAuditLog } from "../../fleet/services.js";

export interface AdminNotesRouteDeps {
  db: DrizzleDb;
}

let _notesStore: IAdminNotesRepository | null = null;

/** Override the store (used in tests or for explicit wiring). */
export function setAdminNotesDeps(deps: AdminNotesRouteDeps): void {
  _notesStore = new AdminNotesStore(deps.db);
}

function getNotesStore(): IAdminNotesRepository {
  if (!_notesStore) {
    _notesStore = new AdminNotesStore(getDb());
  }
  return _notesStore;
}

/** Backward-compatible factory: takes a DrizzleDb and creates a store internally. */
export function createAdminNotesApiRoutes(db: DrizzleDb): Hono<AuthEnv> {
  const store = new AdminNotesStore(db);
  return _create(() => store, getAdminAuditLog);
}

const metadataMap = buildTokenMetadataMap();
const adminAuth = scopedBearerAuthWithTenant(metadataMap, "admin");

/** Pre-built admin notes routes with auth. */
export const adminNotesRoutes = new Hono<AuthEnv>();
adminNotesRoutes.use("*", adminAuth);
adminNotesRoutes.route("/", _create(getNotesStore, getAdminAuditLog));
