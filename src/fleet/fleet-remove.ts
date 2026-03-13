import { logger } from "@wopr-network/platform-core/config/logger";
import type { FleetManager } from "@wopr-network/platform-core/fleet/fleet-manager";
import type { IServiceKeyRepository } from "@wopr-network/platform-core/gateway/service-key-repository";

/**
 * Permanently remove a bot instance and revoke its gateway service key.
 *
 * Revocation is best-effort and happens AFTER fleet.remove() succeeds —
 * revoking before removal risks leaving a running instance without credentials
 * if remove() throws. A revocation failure is logged but does not propagate.
 *
 * Use this for all permanent-delete paths (REST DELETE, tRPC removeInstance,
 * tRPC controlInstance destroy). Do NOT use it for temporary container
 * recreation (e.g. tier changes that remove+recreate the same instance).
 */
export async function removeInstance(
  fleet: FleetManager,
  keyRepo: IServiceKeyRepository | null | undefined,
  id: string,
  removeVolumes?: boolean,
): Promise<void> {
  await fleet.remove(id, removeVolumes);
  if (keyRepo) {
    try {
      await keyRepo.revokeByInstance(id);
    } catch (err) {
      logger.warn("Gateway service key revocation failed (non-fatal)", { botId: id, err });
    }
  }
}
