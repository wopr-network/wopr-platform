import {
  createInternalNodeRoutes,
  type INodeRegistrar,
  type INodeRepoForRegistration,
  type IRegistrationTokenStore,
} from "@wopr-network/platform-core/api/routes/internal-nodes";
import { logger } from "@wopr-network/platform-core/config/logger";
import { getNodeRegistrar, getNodeRepo, getRegistrationTokenStore } from "@wopr-network/platform-core/fleet/services";
import { validateNodeHost } from "@wopr-network/platform-core/security";

export type {
  INodeRegistrar,
  INodeRepoForRegistration,
  InternalNodeDeps,
  IRegistrationTokenStore,
} from "@wopr-network/platform-core/api/routes/internal-nodes";
// Re-export factory and types from core
export { createInternalNodeRoutes } from "@wopr-network/platform-core/api/routes/internal-nodes";

/** Pre-built internal node routes with platform services. */
export const internalNodeRoutes = createInternalNodeRoutes({
  nodeRegistrar: getNodeRegistrar as unknown as () => INodeRegistrar,
  nodeRepo: getNodeRepo as unknown as () => INodeRepoForRegistration,
  registrationTokenStore: getRegistrationTokenStore as unknown as () => IRegistrationTokenStore,
  validateNodeHost,
  logger,
});
