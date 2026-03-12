import type {
  NpmPluginDiscoverer,
  PluginVolumeInstaller,
} from "@wopr-network/platform-core/api/routes/admin-marketplace";
import { createAdminMarketplaceRoutes as _create } from "@wopr-network/platform-core/api/routes/admin-marketplace";
import type { AuthEnv } from "@wopr-network/platform-core/auth";
import type { IMarketplacePluginRepository } from "@wopr-network/platform-core/marketplace/marketplace-plugin-repository";
import type { Hono } from "hono";
import { getAdminAuditLog } from "../../platform-services.js";

/** Backward-compatible factory that wires up WOPR platform services. */
export function createAdminMarketplaceRoutes(repoFactory: () => IMarketplacePluginRepository): Hono<AuthEnv> {
  return _create({
    repoFactory,
    auditLogger: getAdminAuditLog,
    volumeInstaller: (): PluginVolumeInstaller => ({
      async installPluginToVolume(opts) {
        const { installPluginToVolume } = await import("@wopr-network/platform-core/marketplace/volume-installer");
        return installPluginToVolume(opts);
      },
    }),
    pluginVolumePath: process.env.PLUGIN_VOLUME_PATH ?? "/data/plugins",
    discoverer: (): NpmPluginDiscoverer => ({
      async discoverNpmPlugins(opts) {
        const { discoverNpmPlugins } = await import("@wopr-network/platform-core/marketplace/npm-discovery");
        return discoverNpmPlugins(opts);
      },
    }),
  });
}
