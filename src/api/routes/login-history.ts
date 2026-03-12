import { createLoginHistoryRoutes } from "@wopr-network/platform-core/api/routes/login-history";
import type { ILoginHistoryRepository } from "@wopr-network/platform-core/auth/login-history-repository";

let _repoOverride: ILoginHistoryRepository | null = null;
let _repoFactory: (() => ILoginHistoryRepository) | null = null;

/** Inject a test repo (pass null to reset). */
export function setLoginHistoryRepo(repo: ILoginHistoryRepository | null): void {
  _repoOverride = repo;
}

/** Set the production repo factory (called from index.ts). */
export function setLoginHistoryRepoFactory(factory: () => ILoginHistoryRepository): void {
  _repoFactory = factory;
}

function resolveRepo(): ILoginHistoryRepository {
  if (_repoOverride) return _repoOverride;
  if (_repoFactory) return _repoFactory();
  throw new Error("Login history repository not configured");
}

/** Pre-built login history routes for wopr-platform. */
export const loginHistoryRoutes = createLoginHistoryRoutes(resolveRepo);

// Re-export factory for other brands
export { createLoginHistoryRoutes } from "@wopr-network/platform-core/api/routes/login-history";
