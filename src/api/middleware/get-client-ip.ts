import type { Context } from "hono";

/**
 * Parse the TRUSTED_PROXY_IPS env var into a Set of IP addresses.
 * Returns an empty set if the value is undefined or empty.
 */
export function parseTrustedProxies(envValue: string | undefined): Set<string> {
  if (!envValue) return new Set();
  return new Set(
    envValue
      .split(",")
      .map((ip) => ip.trim())
      .filter(Boolean),
  );
}

/** Strip IPv6-mapped-IPv4 prefix (::ffff:) for comparison. */
function normalizeIp(ip: string): string {
  return ip.startsWith("::ffff:") ? ip.slice(7) : ip;
}

// Parsed once at module load — no per-request overhead.
const trustedProxies = parseTrustedProxies(process.env.TRUSTED_PROXY_IPS);

/**
 * Determine the real client IP.
 *
 * - If `socketAddr` matches a trusted proxy, use the **last** (rightmost)
 *   value from `X-Forwarded-For` (closest hop to the trusted proxy).
 * - Otherwise, use `socketAddr` directly (XFF is untrusted).
 * - Falls back to `"unknown"` if neither is available.
 */
export function getClientIp(
  xffHeader: string | undefined,
  socketAddr: string | undefined,
  trusted: Set<string> = trustedProxies,
): string {
  const normalizedSocket = socketAddr ? normalizeIp(socketAddr) : undefined;

  if (xffHeader && normalizedSocket && trusted.has(normalizedSocket)) {
    // Trust XFF — take the rightmost (last) value
    const parts = xffHeader.split(",");
    const last = parts[parts.length - 1]?.trim();
    if (last) return last;
  }

  if (socketAddr) return socketAddr;
  return "unknown";
}

/**
 * Convenience wrapper: extract client IP from a Hono Context.
 * Reads XFF header and socket address from the request.
 * Optionally accepts a trusted proxy set (defaults to the module-level set
 * parsed from TRUSTED_PROXY_IPS — useful for testing).
 */
export function getClientIpFromContext(c: Context, trusted?: Set<string>): string {
  const xff = c.req.header("x-forwarded-for");
  const incoming = (c.env as Record<string, unknown>)?.incoming as { socket?: { remoteAddress?: string } } | undefined;
  const socketAddr = incoming?.socket?.remoteAddress;
  return trusted !== undefined ? getClientIp(xff, socketAddr, trusted) : getClientIp(xff, socketAddr);
}
