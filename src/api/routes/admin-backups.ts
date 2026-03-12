import { createAdminBackupRoutes as _create } from "@wopr-network/platform-core/api/routes/admin-backups";
import type { AuthEnv } from "@wopr-network/platform-core/auth";
import { buildTokenMetadataMap, scopedBearerAuthWithTenant } from "@wopr-network/platform-core/auth";
import type { IBackupStatusStore } from "@wopr-network/platform-core/backup/backup-status-store";
import { SpacesClient } from "@wopr-network/platform-core/backup/spaces-client";
import { getBackupStatusStore } from "@wopr-network/platform-core/fleet/services";
import { Hono } from "hono";
import { getAdminAuditLog } from "../../platform-services.js";

// Re-export helper from core
export { isRemotePathOwnedBy } from "@wopr-network/platform-core/api/routes/admin-backups";

/** Backward-compatible factory: takes direct store, optional spaces client. */
export function createAdminBackupRoutes(
  store: import("@wopr-network/platform-core/backup/backup-status-store").IBackupStatusStore,
  spaces?: import("@wopr-network/platform-core/backup/spaces-client").SpacesClient,
) {
  const spacesClient = spaces ?? getSpaces();
  return _create(
    () => store,
    () => spacesClient,
    getAdminAuditLog,
  );
}

const S3_BUCKET = process.env.S3_BUCKET || "wopr-backups";

function getStore(): IBackupStatusStore {
  return getBackupStatusStore();
}

let _spaces: SpacesClient | null = null;
function getSpaces(): SpacesClient {
  if (!_spaces) {
    _spaces = new SpacesClient(S3_BUCKET);
  }
  return _spaces;
}

const metadataMap = buildTokenMetadataMap();
const adminAuth = scopedBearerAuthWithTenant(metadataMap, "admin");

/** Pre-built admin backup routes with auth and lazy initialization. */
export const adminBackupRoutes = new Hono<AuthEnv>();
adminBackupRoutes.use("*", adminAuth);
adminBackupRoutes.route("/", _create(getStore, getSpaces, getAdminAuditLog));

export { getStore };
