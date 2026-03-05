import { execFile as defaultExecFile } from "node:child_process";
import { logger } from "../config/logger.js";
import type { IMarketplacePluginRepository } from "./marketplace-plugin-repository.js";

const VALID_NPM_PACKAGE = /^(@[a-z0-9~][a-z0-9-._~]*\/)?[a-z0-9~][a-z0-9-._~]*$/;
const VALID_SEMVER = /^\d+\.\d+\.\d+(-[a-zA-Z0-9.-]+)?(\+[a-zA-Z0-9.-]+)?$/;

function validateNpmPackageSpec(npmPackage: string, version: string): void {
  if (!VALID_NPM_PACKAGE.test(npmPackage)) {
    throw new Error(`Invalid npm package name: ${npmPackage}`);
  }
  if (!VALID_SEMVER.test(version)) {
    throw new Error(`Invalid npm version: ${version}`);
  }
}

export interface InstallOptions {
  pluginId: string;
  npmPackage: string;
  version: string;
  volumePath: string;
  repo: IMarketplacePluginRepository;
  execFn?: typeof defaultExecFile;
}

async function runNpmInstall(
  npmPackage: string,
  version: string,
  volumePath: string,
  execFn: typeof defaultExecFile,
): Promise<void> {
  validateNpmPackageSpec(npmPackage, version);
  const pkg = `${npmPackage}@${version}`;
  await new Promise<string>((resolve, reject) => {
    execFn("npm", ["install", "--", pkg], { cwd: volumePath, timeout: 120_000 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr || err.message));
      } else {
        resolve(stdout);
      }
    });
  });
}

export async function installPluginToVolume(options: InstallOptions): Promise<void> {
  const { pluginId, npmPackage, version, volumePath, repo, execFn = defaultExecFile } = options;

  const pkg = `${npmPackage}@${version}`;
  logger.info("Installing plugin to shared volume", { pluginId, pkg, volumePath });

  try {
    await runNpmInstall(npmPackage, version, volumePath, execFn);
    await repo.setInstallResult(pluginId, Date.now(), null);
    logger.info("Plugin installed successfully", { pluginId, pkg });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await repo.setInstallResult(pluginId, null, message);
    logger.error("Plugin install failed", { pluginId, pkg, error: message });
  }
}

export interface UpgradeOptions {
  pluginId: string;
  npmPackage: string;
  targetVersion: string;
  volumePath: string;
  repo: IMarketplacePluginRepository;
  execFn?: typeof defaultExecFile;
}

export async function upgradePluginOnVolume(options: UpgradeOptions): Promise<void> {
  const { pluginId, npmPackage, targetVersion, volumePath, repo, execFn = defaultExecFile } = options;

  const existing = await repo.findById(pluginId);
  if (!existing) {
    throw new Error(`Plugin not found: ${pluginId}`);
  }

  const pkg = `${npmPackage}@${targetVersion}`;
  logger.info("Upgrading plugin on shared volume", { pluginId, from: existing.version, to: targetVersion, volumePath });

  try {
    validateNpmPackageSpec(npmPackage, targetVersion);
    await repo.setVersion(pluginId, targetVersion, existing.version);
    await runNpmInstall(npmPackage, targetVersion, volumePath, execFn);
    await repo.setInstallResult(pluginId, Date.now(), null);
    logger.info("Plugin upgraded successfully", { pluginId, pkg });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await repo.setInstallResult(pluginId, null, message);
    logger.error("Plugin upgrade failed", { pluginId, pkg, error: message });
    throw err;
  }
}

export interface RollbackOptions {
  pluginId: string;
  npmPackage: string;
  previousVersion: string;
  volumePath: string;
  repo: IMarketplacePluginRepository;
  execFn?: typeof defaultExecFile;
}

export async function rollbackPluginOnVolume(options: RollbackOptions): Promise<void> {
  const { pluginId, npmPackage, previousVersion, volumePath, repo, execFn = defaultExecFile } = options;

  const existing = await repo.findById(pluginId);
  if (!existing) {
    throw new Error(`Plugin not found: ${pluginId}`);
  }
  if (options.previousVersion !== existing.previousVersion) {
    throw new Error(
      `previousVersion mismatch: expected ${existing.previousVersion ?? "null"}, got ${options.previousVersion}`,
    );
  }

  const pkg = `${npmPackage}@${previousVersion}`;
  logger.info("Rolling back plugin on shared volume", {
    pluginId,
    from: existing.version,
    to: previousVersion,
    volumePath,
  });

  try {
    await runNpmInstall(npmPackage, previousVersion, volumePath, execFn);
    await repo.setVersion(pluginId, previousVersion, null);
    await repo.setInstallResult(pluginId, Date.now(), null);
    logger.info("Plugin rolled back successfully", { pluginId, pkg });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await repo.setInstallResult(pluginId, null, message);
    logger.error("Plugin rollback failed", { pluginId, pkg, error: message });
    throw err;
  }
}
