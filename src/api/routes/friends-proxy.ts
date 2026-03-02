import { logger } from "../../config/logger.js";

/**
 * Result from proxying a request to a bot instance's P2P friend API.
 */
export interface ProxyResult {
  ok: boolean;
  status: number;
  data?: unknown;
  error?: string;
}

/** Allowed path prefixes — proxy targets must live under /p2p/ or /plugins/. */
const ALLOWED_PATH_RE = /^\/(?:p2p|plugins)\/[a-zA-Z0-9/_-]*$|^\/plugins\/install$/;

/** Allowed HTTP methods for proxying. */
const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]);

/**
 * Proxy a request to a bot instance's internal friend management API.
 *
 * The platform never parses friend data itself -- it acts as a pass-through
 * to the WOPR instance's P2P plugin HTTP API running inside the container.
 *
 * @param instanceId - The bot instance identifier (used to build the container hostname)
 * @param method - HTTP method (GET, POST, PUT, PATCH, DELETE)
 * @param path - The API path on the instance (e.g., "/p2p/friends")
 * @param body - Optional request body (will be JSON-serialized)
 */
export async function proxyToInstance(
  instanceId: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<ProxyResult> {
  // --- SSRF defense (WOP-1288) ---
  if (!ALLOWED_METHODS.has(method)) {
    throw new Error(`proxyToInstance: disallowed method ${method}`);
  }

  // Decode percent-encoded characters before checking, to prevent %2e%2e bypass
  const decodedPath = decodeURIComponent(path);
  if (
    !ALLOWED_PATH_RE.test(decodedPath) ||
    decodedPath.includes("..") ||
    decodedPath.includes("?") ||
    decodedPath.includes("#") ||
    decodedPath.includes("://") ||
    /[\r\n]/.test(path)
  ) {
    throw new Error(`proxyToInstance: disallowed path ${path}`);
  }

  const instanceUrl = `http://wopr-${instanceId}:3000${path}`;

  try {
    const init: RequestInit = {
      method,
      headers: { "Content-Type": "application/json" },
    };

    if (body !== undefined && method !== "GET" && method !== "HEAD") {
      init.body = JSON.stringify(body);
    }

    const response = await fetch(instanceUrl, init);
    const contentType = response.headers.get("content-type") || "";

    if (contentType.includes("application/json")) {
      const data = await response.json();
      return { ok: response.ok, status: response.status, data };
    }

    const text = await response.text();
    if (response.ok) {
      return { ok: true, status: response.status, data: text || null };
    }
    return { ok: false, status: response.status, error: text || "Request failed" };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    logger.error(`Failed to proxy to instance ${instanceId}`, { path, error: message });

    // Distinguish between connection errors (instance down) and other failures
    if (message.includes("ECONNREFUSED") || message.includes("ENOTFOUND")) {
      return { ok: false, status: 503, error: "Instance unavailable" };
    }
    return { ok: false, status: 502, error: "Failed to reach instance" };
  }
}
