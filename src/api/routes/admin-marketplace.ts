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
    volumeInstaller: () => {
      // Dynamic import for fire-and-forget volume installation
      const mod = require("@wopr-network/platform-core/marketplace/volume-installer") as {
        installPluginToVolume: (opts: unknown) => Promise<void>;
      };
      return { installPluginToVolume: mod.installPluginToVolume };
    },
    pluginVolumePath: process.env.PLUGIN_VOLUME_PATH ?? "/data/plugins",
    discoverer: () => {
      const mod = require("@wopr-network/platform-core/marketplace/npm-discovery") as {
        discoverNpmPlugins: (opts: {
          repo: IMarketplacePluginRepository;
          notify: (msg: string) => void;
        }) => Promise<{ discovered: number; skipped: number }>;
      };
      return { discoverNpmPlugins: mod.discoverNpmPlugins };
    },
  });
}
