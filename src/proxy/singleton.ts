import { ProxyManager } from "./manager.js";

const PLATFORM_DOMAIN = process.env.PLATFORM_DOMAIN || "wopr.bot";

let _pm: ProxyManager | null = null;

export function getProxyManager(): ProxyManager {
  if (!_pm) {
    _pm = new ProxyManager({ domain: PLATFORM_DOMAIN });
  }
  return _pm;
}
