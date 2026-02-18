import { logger } from "../config/logger.js";
import type { ProfileStore } from "../fleet/profile-store.js";
import type { BotProfile } from "../fleet/types.js";
import { ProxyManager } from "./manager.js";

const PLATFORM_DOMAIN = process.env.PLATFORM_DOMAIN || "wopr.bot";

let _pm: ProxyManager | null = null;

export function getProxyManager(): ProxyManager {
  if (!_pm) {
    _pm = new ProxyManager({ domain: PLATFORM_DOMAIN });
  }
  return _pm;
}

/**
 * Hydrate proxy routes from persisted profiles on startup.
 * Without this, every server restart empties the in-memory route table and
 * all tenant subdomains return 404 until bots are re-created or restarted.
 */
export async function hydrateProxyRoutes(store: ProfileStore): Promise<void> {
  const pm = getProxyManager();
  let profiles: BotProfile[] | undefined;
  try {
    profiles = await store.list();
  } catch (err) {
    logger.warn("Proxy hydration skipped: could not list profiles", { err });
    return;
  }
  for (const profile of profiles) {
    try {
      const subdomain = profile.name.toLowerCase().replace(/_/g, "-");
      await pm.addRoute({
        instanceId: profile.id,
        subdomain,
        upstreamHost: `wopr-${subdomain}`,
        upstreamPort: 7437,
        healthy: true,
      });
    } catch (err) {
      logger.warn(`Proxy hydration: skipped route for profile ${profile.id}`, { err });
    }
  }
  logger.info(`Proxy hydrated ${profiles.length} route(s) from persisted profiles`);
}
