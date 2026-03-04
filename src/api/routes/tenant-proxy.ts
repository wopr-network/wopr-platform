import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { getAuth } from "../../auth/better-auth.js";
import { validateTenantAccess } from "../../auth/index.js";
import { logger } from "../../config/logger.js";
import { ProfileStore } from "../../fleet/profile-store.js";
import { getOrgMemberRepo } from "../../fleet/services.js";

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

const FLEET_DATA_DIR = process.env.FLEET_DATA_DIR || "/data/fleet";

/** Headers safe to forward to upstream tenant containers. */
const FORWARDED_HEADERS = [
  "content-type",
  "accept",
  "accept-language",
  "accept-encoding",
  "content-length",
  "x-request-id",
  "user-agent",
];

/**
 * Build a sanitized Headers object for upstream requests.
 * Only forwards allowlisted headers and injects platform identity headers.
 */
export function buildUpstreamHeaders(incoming: Headers, userId: string, tenantSubdomain: string): Headers {
  const headers = new Headers();
  for (const key of FORWARDED_HEADERS) {
    const val = incoming.get(key);
    if (val) headers.set(key, val);
  }
  headers.set("x-wopr-user-id", userId);
  headers.set("x-wopr-tenant-id", tenantSubdomain);
  return headers;
}

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

  // Resolve session user — the proxy runs before resolveSessionUser() middleware,
  // so we must resolve inline. Reject unauthenticated requests with 401 (WOP-1372).
  let userId: string | undefined;
  try {
    userId = (c.get("user") as { id: string } | undefined)?.id;
  } catch {
    // Variable not set — continue to session resolution
  }

  if (!userId) {
    try {
      const auth = getAuth();
      const session = await auth.api.getSession({ headers: c.req.raw.headers });
      if (session?.user) {
        userId = (session.user as { id: string }).id;
      }
    } catch (err) {
      logger.warn("Session resolution failed for tenant proxy request", { err });
    }
  }

  if (!userId) {
    return c.json({ error: "Authentication required" }, 401);
  }

  // --- Tenant ownership check (WOP-1605) ---
  // Look up the bot profile to get its tenantId, then verify the user belongs to that tenant.
  let tenantId: string | undefined;
  try {
    const store = new ProfileStore(FLEET_DATA_DIR);
    const profile = await store.get(route.instanceId);
    tenantId = profile?.tenantId;
  } catch {
    // Profile lookup failed — fall through to deny
  }

  if (!tenantId) {
    return c.json({ error: "Tenant not found" }, 404);
  }

  const orgMemberRepo = getOrgMemberRepo();
  const allowed = await validateTenantAccess(userId, tenantId, orgMemberRepo);
  if (!allowed) {
    logger.debug(`User ${userId} not authorized for tenant ${tenantId} (subdomain: ${subdomain})`);
    return c.json({ error: "Not authorized for this tenant" }, 403);
  }

  // Proxy the request to the upstream container
  const upstream = `http://${route.upstreamHost}:${route.upstreamPort}`;
  const url = new URL(c.req.url);
  const targetUrl = `${upstream}${url.pathname}${url.search}`;

  const upstreamHeaders = buildUpstreamHeaders(c.req.raw.headers, userId, subdomain);

  let response: Response;
  try {
    response = await fetch(targetUrl, {
      method: c.req.method,
      headers: upstreamHeaders,
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
