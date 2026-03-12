import { createInternalGpuRoutes } from "@wopr-network/platform-core/api/routes/internal-gpu";
import { getGpuNodeRepo } from "@wopr-network/platform-core/fleet/services";

// Re-export factory from core
export { createInternalGpuRoutes } from "@wopr-network/platform-core/api/routes/internal-gpu";

/** Pre-built internal GPU routes wired to WOPR services. */
export const internalGpuRoutes = createInternalGpuRoutes(() => process.env.GPU_NODE_SECRET, getGpuNodeRepo);
