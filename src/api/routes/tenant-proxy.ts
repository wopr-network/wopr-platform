import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { logger } from "../../config/logger.js";

/**
 * Domain config, read once at startup.
 * PLATFORM_DOMAIN controls which domain to strip subdomains from.
 * Defaults to "wopr.bot" for production.
 */
const PLATFORM_DOMAIN = process.env.PLATFORM_DOMAIN || "wopr.bot";

/** Reserved subdomains that should never resolve to a tenant. */
const RESERVED_SUBDOMAINS = new Set([
  "app",
  "api",
  "staging",
  "www",
  "mail",
  "smtp",
  "ftp",
  "admin",
  "dashboard",
  "status",
  "docs",
]);

/** DNS label rules (RFC 1123) — compiled once at module scope. */
const SUBDOMAIN_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Extract the tenant subdomain from a Host header value.
 * Returns null if the host is the root domain, a reserved subdomain,
 * or doesn't match the platform domain.
 *
 * Examples:
 *   "alice.wopr.bot"   → "alice"
 *   "wopr.bot"         → null (root domain)
 *   "app.wopr.bot"     → null (reserved)
 *   "evil.example.com" → null (wrong domain)
 */
export function extractTenantSubdomain(host: string): string | null {
  // Strip port if present
  const hostname = host.split(":")[0].toLowerCase();

  // Must end with .{PLATFORM_DOMAIN}
  const suffix = `.${PLATFORM_DOMAIN}`;
  if (!hostname.endsWith(suffix)) return null;

  // Extract the subdomain part
  const subdomain = hostname.slice(0, -suffix.length);

  // Must be a single label (no dots — no sub-sub-domains)
  if (!subdomain || subdomain.includes(".")) return null;

  // Must not be reserved
  if (RESERVED_SUBDOMAINS.has(subdomain)) return null;

  // Must match DNS label rules (RFC 1123)
  if (!SUBDOMAIN_RE.test(subdomain)) return null;

  return subdomain;
}

/**
 * Tenant subdomain proxy middleware.
 *
 * If the request Host header identifies a tenant subdomain (e.g. alice.wopr.bot),
 * the request is proxied to the upstream container for that tenant.
 *
 * If the host is absent, the root domain, a reserved subdomain, or localhost,
 * the middleware calls next() so subsequent routes (health, API, etc.) handle
 * the request normally. This is critical for tests and direct-IP access.
 */
export const tenantProxyMiddleware: MiddlewareHandler = async (c, next) => {
  const host = c.req.header("host");
  if (!host) return next();

  const subdomain = extractTenantSubdomain(host);
  if (!subdomain) return next();

  const { getProxyManager } = await import("../../proxy/singleton.js");
  const pm = getProxyManager();
  const routes = pm.getRoutes();
  const route = routes.find((r) => r.subdomain === subdomain);

  if (!route) {
    logger.debug(`Tenant not found for subdomain: ${subdomain}`);
    return c.json({ error: "Tenant not found" }, 404);
  }

  if (!route.healthy) {
    return c.json({ error: "Instance unavailable" }, 503);
  }

  // Proxy the request to the upstream container
  const upstream = `http://${route.upstreamHost}:${route.upstreamPort}`;
  const url = new URL(c.req.url);
  const targetUrl = `${upstream}${url.pathname}${url.search}`;

  let response: Response;
  try {
    response = await fetch(targetUrl, {
      method: c.req.method,
      headers: c.req.raw.headers,
      body: c.req.method !== "GET" && c.req.method !== "HEAD" ? c.req.raw.body : undefined,
      // @ts-expect-error -- duplex needed for streaming request bodies
      duplex: "half",
    });
  } catch (err) {
    logger.warn(`Upstream fetch failed for subdomain "${subdomain}"`, { err });
    return c.json({ error: "Bad Gateway: upstream container unavailable" }, 502);
  }

  return new Response(response.body, {
    status: response.status,
    headers: response.headers,
  });
};

// Keep the Hono sub-app export for backward compatibility with existing tests
// that import tenantProxyRoutes directly.
export const tenantProxyRoutes = new Hono();
tenantProxyRoutes.use("/*", tenantProxyMiddleware);
