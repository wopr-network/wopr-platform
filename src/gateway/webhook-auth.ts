/**
 * Webhook authentication middleware for Twilio/Telnyx inbound endpoints.
 *
 * Replaces serviceKeyAuth on webhook routes. Instead of Bearer token auth,
 * verifies provider-specific webhook signatures (X-Twilio-Signature HMAC).
 *
 * Follows the same exponential backoff pattern as Stripe webhook auth
 * in src/api/routes/billing.ts.
 */

import type { Context, Next } from "hono";
import type { ISigPenaltyRepository } from "../api/sig-penalty-repository.js";
import { logger } from "../config/logger.js";
import type { GatewayAuthEnv } from "./service-key-auth.js";
import { validateTwilioSignature } from "./twilio-signature.js";
import type { GatewayTenant } from "./types.js";

export interface TwilioWebhookAuthConfig {
  /** Twilio auth token for HMAC verification */
  twilioAuthToken: string;
  /** The base URL that Twilio sends webhooks to (e.g., https://api.wopr.network/v1) */
  webhookBaseUrl: string;
  /** Resolve tenant from a webhook request context */
  resolveTenantFromWebhook: (c: Context) => GatewayTenant | null;
  /** Repository for tracking per-IP signature failure penalties */
  sigPenaltyRepo: ISigPenaltyRepository;
}

function getClientIp(c: Context): string {
  const xff = c.req.header("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const incoming = (c.env as Record<string, unknown>)?.incoming as { socket?: { remoteAddress?: string } } | undefined;
  return incoming?.socket?.remoteAddress ?? "unknown";
}

/**
 * Create Twilio webhook authentication middleware.
 *
 * Verifies the X-Twilio-Signature HMAC header on inbound webhook requests.
 * On success, resolves and sets the gatewayTenant in context.
 * On failure, applies exponential IP-based backoff to deter brute-force attacks.
 */
export function createTwilioWebhookAuth(config: TwilioWebhookAuthConfig) {
  return async (c: Context<GatewayAuthEnv>, next: Next) => {
    const ip = getClientIp(c);
    const now = Date.now();

    // Check if this IP is currently in penalty backoff
    const penalty = await config.sigPenaltyRepo.get(ip, "twilio");
    if (penalty && now < penalty.blockedUntil) {
      const retryAfterSec = Math.ceil((penalty.blockedUntil - now) / 1000);
      c.header("Retry-After", String(retryAfterSec));
      return c.json({ error: "Too many failed webhook signature attempts" }, 429);
    }

    // Require X-Twilio-Signature header
    const signature = c.req.header("x-twilio-signature");
    if (!signature) {
      return c.json({ error: "Missing X-Twilio-Signature header" }, 400);
    }

    // Reconstruct the full URL that Twilio was configured to send to.
    // webhookBaseUrl is the public-facing base (e.g., https://api.wopr.network/v1).
    // We derive the path-after-base by parsing the request URL, extracting the
    // pathname, then stripping the base path prefix that is already in webhookBaseUrl.
    const parsedBase = new URL(config.webhookBaseUrl);
    const basePath = parsedBase.pathname.replace(/\/$/, ""); // e.g., "/v1"

    const parsedReq = new URL(c.req.url, "http://localhost");
    const reqPath = parsedReq.pathname; // e.g., "/v1/phone/inbound/tenant-abc"

    // Strip the base path prefix from the request path so we don't double it
    const relativePath = reqPath.startsWith(basePath) ? reqPath.slice(basePath.length) : reqPath;

    // Full URL = webhookBaseUrl (no trailing slash) + relative path + query string
    // Twilio's HMAC algorithm includes the complete URL with all query parameters.
    const fullUrl = config.webhookBaseUrl.replace(/\/$/, "") + relativePath + parsedReq.search;

    // Parse body params for signature verification.
    // Twilio sends application/x-www-form-urlencoded; we also support JSON for adapters/testing.
    //
    // We track two things:
    //   params     — scalar string values used for Twilio HMAC signature computation
    //   fullBody   — the complete parsed body passed to downstream handlers
    let params: Record<string, string> = {};
    let fullBody: Record<string, unknown> = {};
    const contentType = c.req.header("content-type") ?? "";
    try {
      if (contentType.includes("application/x-www-form-urlencoded")) {
        const text = await c.req.text();
        const urlParams = new URLSearchParams(text);
        for (const [key, value] of urlParams.entries()) {
          params[key] = value;
          fullBody[key] = value;
        }
      } else {
        // JSON body — stringify all top-level scalar values for signature computation.
        // Twilio normally sends form-encoded data, so all values are strings.
        // For JSON adapters/testing, coerce scalars to strings to match Twilio's algorithm.
        const json = await c.req.json<Record<string, unknown>>();
        fullBody = json;
        for (const [key, value] of Object.entries(json)) {
          if (value !== null && value !== undefined && !Array.isArray(value) && typeof value !== "object") {
            params[key] = String(value);
          }
        }
      }
    } catch {
      // Empty or unparseable body — use empty params
      params = {};
      fullBody = {};
    }

    // Verify Twilio HMAC-SHA1 signature
    const valid = validateTwilioSignature(config.twilioAuthToken, signature, fullUrl, params);

    if (!valid) {
      // Track signature failure for exponential backoff
      const updated = await config.sigPenaltyRepo.recordFailure(ip, "twilio");

      logger.error("Twilio webhook signature verification failed", {
        ip,
        consecutiveFailures: updated.failures,
        url: fullUrl,
      });
      return c.json({ error: "Invalid webhook signature" }, 400);
    }

    // Clear any stale penalties on successful verification
    await config.sigPenaltyRepo.clear(ip, "twilio");

    // Resolve tenant from webhook context
    const tenant = config.resolveTenantFromWebhook(c);
    if (!tenant) {
      return c.json(
        {
          error: {
            message: "Tenant not found",
            type: "authentication_error",
            code: "invalid_tenant",
          },
        },
        401,
      );
    }

    c.set("gatewayTenant", tenant);
    // Store the full parsed body so downstream handlers can read it without
    // consuming the already-drained request body stream a second time.
    c.set("webhookBody", fullBody);
    return next();
  };
}
