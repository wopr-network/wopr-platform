import { createHealthRoutes } from "@wopr-network/platform-core/api/routes/health";
import { getBackupStatusStore } from "@wopr-network/platform-core/fleet/services";

function getHealthStore() {
  try {
    return getBackupStatusStore();
  } catch {
    return null;
  }
}

/** Pre-built health routes for wopr-platform. */
export const healthRoutes = createHealthRoutes({
  serviceName: "wopr-platform",
  storeFactory: getHealthStore,
});

// Re-export factory for tests
export { createHealthRoutes } from "@wopr-network/platform-core/api/routes/health";
