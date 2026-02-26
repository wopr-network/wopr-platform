import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import type { AuthEnv } from "../../auth/index.js";
import { logger } from "../../config/logger.js";
import type { IOAuthStateRepository } from "../oauth-state-repository.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface OAuthProviderConfig {
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scopes: string[];
  /** Additional query params for the authorize URL */
  extraParams?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Provider configs (from env vars)
// ---------------------------------------------------------------------------

function getSlackConfig(): OAuthProviderConfig | null {
  const clientId = process.env.SLACK_CLIENT_ID;
  const clientSecret = process.env.SLACK_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return {
    authorizeUrl: "https://slack.com/oauth/v2/authorize",
    tokenUrl: "https://slack.com/api/oauth.v2.access",
    clientId,
    clientSecret,
    scopes: ["channels:history", "channels:read", "chat:write", "users:read"],
    extraParams: { user_scope: "" },
  };
}

const PROVIDER_CONFIGS: Record<string, () => OAuthProviderConfig | null> = {
  slack: getSlackConfig,
};

function getProviderConfig(provider: string): OAuthProviderConfig | null {
  const factory = PROVIDER_CONFIGS[provider];
  return factory ? factory() : null;
}

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

const initiateSchema = z.object({
  provider: z.string().min(1).max(64),
});

// ---------------------------------------------------------------------------
// Module-level wiring (for app.ts / services.ts)
// ---------------------------------------------------------------------------

let _oauthRepo: IOAuthStateRepository | null = null;

/** Inject the OAuth state repository. Call before serving (from services.ts). */
export function setChannelOAuthRepo(repo: IOAuthStateRepository): void {
  _oauthRepo = repo;
}

function getOAuthRepo(): IOAuthStateRepository {
  if (!_oauthRepo) {
    throw new Error("Channel OAuth repo not initialized — call setChannelOAuthRepo() first");
  }
  return _oauthRepo;
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

// BOUNDARY(WOP-805): REST is the correct layer for OAuth redirect flows.
// OAuth initiate sends an HTTP redirect to the provider's authorize URL.
// OAuth callback receives a redirect with code/state query params.
// This cannot be expressed as tRPC (which returns JSON, not redirects).
export function createChannelOAuthRoutes(oauthRepo: IOAuthStateRepository): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  /**
   * POST /api/channel-oauth/initiate
   *
   * Generates an OAuth authorization URL for the given provider.
   * Returns { authorizeUrl, state } for the frontend to open in a popup.
   *
   * Requires authenticated session (user must be logged in).
   */
  app.post("/initiate", async (c) => {
    let user: { id: string } | undefined;
    try {
      user = c.get("user");
    } catch {
      // not set
    }
    if (!user) {
      return c.json({ error: "Authentication required" }, 401);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = initiateSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid input", details: parsed.error.flatten().fieldErrors }, 400);
    }

    const { provider } = parsed.data;
    const config = getProviderConfig(provider);
    if (!config) {
      return c.json({ error: `OAuth not configured for provider: ${provider}` }, 400);
    }

    const callbackUrl = `${process.env.BETTER_AUTH_URL || "http://localhost:3100"}/api/channel-oauth/callback`;
    const state = randomUUID();
    const now = Date.now();
    await oauthRepo.create({
      state,
      provider,
      userId: user.id,
      redirectUri: callbackUrl,
      createdAt: now,
      expiresAt: now + 10 * 60 * 1000,
    });

    const params = new URLSearchParams({
      client_id: config.clientId,
      scope: config.scopes.join(","),
      redirect_uri: callbackUrl,
      state,
      response_type: "code",
      ...config.extraParams,
    });

    const authorizeUrl = `${config.authorizeUrl}?${params.toString()}`;

    return c.json({ authorizeUrl, state });
  });

  /**
   * GET /api/channel-oauth/callback
   *
   * OAuth callback handler. The provider redirects here after the user
   * authorizes the app. Exchanges the code for a token.
   *
   * This is NOT called by the frontend directly — the provider redirects
   * the popup window here. After exchanging the code, it renders an HTML
   * page that posts a message to the opener window.
   */
  app.get("/callback", async (c) => {
    const code = c.req.query("code");
    const state = c.req.query("state");
    const errorParam = c.req.query("error");

    if (errorParam) {
      return c.html(callbackHtml("error", errorParam));
    }

    if (!code || !state) {
      return c.html(callbackHtml("error", "Missing code or state parameter"));
    }

    const pending = await oauthRepo.consumePending(state);
    if (!pending) {
      return c.html(callbackHtml("error", "Invalid or expired OAuth state"));
    }

    // Probabilistic cleanup: ~1% of requests purge expired rows so the table
    // doesn't grow unbounded (replaces the old in-memory size-based purge).
    if (Math.random() < 0.01) {
      void oauthRepo.purgeExpired();
    }

    const config = getProviderConfig(pending.provider);
    if (!config) {
      return c.html(callbackHtml("error", "Provider configuration not found"));
    }

    // Exchange code for token
    try {
      const tokenResponse = await fetch(config.tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        signal: AbortSignal.timeout(10_000),
        body: new URLSearchParams({
          client_id: config.clientId,
          client_secret: config.clientSecret,
          code,
          redirect_uri: pending.redirectUri,
        }),
      });

      if (!tokenResponse.ok) {
        const text = await tokenResponse.text();
        logger.error("OAuth token exchange failed", {
          provider: pending.provider,
          status: tokenResponse.status,
          body: text.slice(0, 500),
        });
        return c.html(callbackHtml("error", "Token exchange failed"));
      }

      const tokenData = (await tokenResponse.json()) as Record<string, unknown>;

      // Slack returns { ok: true, access_token: "..." } or { ok: false, error: "..." }
      if (pending.provider === "slack") {
        if (!tokenData.ok) {
          return c.html(callbackHtml("error", `Slack error: ${tokenData.error}`));
        }
      }

      // Extract the access token (provider-specific field names)
      const accessToken = extractAccessToken(pending.provider, tokenData);
      if (!accessToken) {
        return c.html(callbackHtml("error", "No access token in response"));
      }

      // Store the completed token keyed by state for frontend polling
      await oauthRepo.completeWithToken(state, accessToken, pending.userId);

      return c.html(callbackHtml("success", state));
    } catch (err) {
      logger.error("OAuth token exchange error", {
        provider: pending.provider,
        error: err instanceof Error ? err.message : String(err),
      });
      return c.html(callbackHtml("error", "Token exchange failed"));
    }
  });

  /**
   * GET /api/channel-oauth/poll?state=<uuid>
   *
   * Frontend polls this endpoint to check if the OAuth flow completed.
   * Returns { status: "pending" | "completed" | "expired", token?: string }.
   *
   * Requires authenticated session. The token is returned exactly once
   * (consumed on read) to prevent replay.
   */
  app.get("/poll", async (c) => {
    let user: { id: string } | undefined;
    try {
      user = c.get("user");
    } catch {
      // not set
    }
    if (!user) {
      return c.json({ error: "Authentication required" }, 401);
    }

    const state = c.req.query("state");
    if (!state) {
      return c.json({ error: "Missing state parameter" }, 400);
    }

    const result = await oauthRepo.consumeCompleted(state, user.id);
    if (!result) {
      return c.json({ status: "pending" });
    }

    return c.json({ status: "completed", token: result.token });
  });

  return app;
}

// ---------------------------------------------------------------------------
// Module-level route instance (for app.ts)
// Delegates to createChannelOAuthRoutes with the injected repo at request time.
// ---------------------------------------------------------------------------

/**
 * Pre-built route instance for use in app.ts.
 * Requires setChannelOAuthRepo() to be called before handling requests.
 */
export const channelOAuthRoutes = createChannelOAuthRoutes({
  create: (data) => getOAuthRepo().create(data),
  consumePending: (state) => getOAuthRepo().consumePending(state),
  completeWithToken: (state, token, userId) => getOAuthRepo().completeWithToken(state, token, userId),
  consumeCompleted: (state, userId) => getOAuthRepo().consumeCompleted(state, userId),
  purgeExpired: () => getOAuthRepo().purgeExpired(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractAccessToken(provider: string, data: Record<string, unknown>): string | null {
  switch (provider) {
    case "slack":
      return (data.access_token as string) || null;
    default:
      return (data.access_token as string) || null;
  }
}

/** Escape a string for safe interpolation into HTML. */
function htmlEscape(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Generate an HTML page that communicates back to the opener window.
 * On success, posts `{ type: "wopr-oauth-callback", status: "success", state }`.
 * On error, posts `{ type: "wopr-oauth-callback", status: "error", error }`.
 * Then closes the popup.
 */
function callbackHtml(status: "success" | "error", payload: string): string {
  // JSON.stringify does not escape </script>, which would allow XSS if payload
  // contains that substring. Replace it so the string cannot break out of the
  // script block regardless of what the OAuth provider returns.
  const safeJson = (v: string) => JSON.stringify(v).replace(/<\/script>/gi, "<\\/script>");
  const message =
    status === "success"
      ? `{ type: "wopr-oauth-callback", status: "success", state: ${safeJson(payload)} }`
      : `{ type: "wopr-oauth-callback", status: "error", error: ${safeJson(payload)} }`;

  return `<!DOCTYPE html>
<html>
<head><title>OAuth Callback</title></head>
<body>
<p>${status === "success" ? "Authorization successful. This window will close." : `Error: ${htmlEscape(payload)}`}</p>
<script>
  if (window.opener) {
    window.opener.postMessage(${message}, window.location.origin);
  }
  setTimeout(function() { window.close(); }, 1500);
</script>
</body>
</html>`;
}
