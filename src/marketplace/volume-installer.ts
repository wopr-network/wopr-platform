import { execFile as defaultExecFile } from "node:child_process";
import { logger } from "../config/logger.js";
import type { IMarketplacePluginRepository } from "./marketplace-plugin-repository.js";

export interface InstallOptions {
  pluginId: string;
  npmPackage: string;
  version: string;
  volumePath: string;
  repo: IMarketplacePluginRepository;
  execFn?: typeof defaultExecFile;
}

export async function installPluginToVolume(options: InstallOptions): Promise<void> {
  const { pluginId, npmPackage, version, volumePath, repo, execFn = defaultExecFile } = options;

  const pkg = `${npmPackage}@${version}`;
  logger.info("Installing plugin to shared volume", { pluginId, pkg, volumePath });

  try {
    await new Promise<string>((resolve, reject) => {
      execFn("npm", ["install", pkg], { cwd: volumePath, timeout: 120_000 }, (err, stdout, stderr) => {
        if (err) {
          reject(new Error(stderr || err.message));
        } else {
          resolve(stdout);
        }
      });
    });
    await repo.setInstallResult(pluginId, Date.now(), null);
    logger.info("Plugin installed successfully", { pluginId, pkg });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await repo.setInstallResult(pluginId, null, message);
    logger.error("Plugin install failed", { pluginId, pkg, error: message });
  }
}
