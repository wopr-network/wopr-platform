import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import type { AuthEnv } from "../../auth/index.js";
import { logger } from "../../config/logger.js";

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

interface PendingOAuthState {
  provider: string;
  userId: string;
  redirectUri: string;
  createdAt: number;
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
// State store (in-memory, 10-minute TTL)
// ---------------------------------------------------------------------------

const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const pendingStates = new Map<string, PendingOAuthState>();

function createState(provider: string, userId: string, redirectUri: string): string {
  const state = randomUUID();
  pendingStates.set(state, {
    provider,
    userId,
    redirectUri,
    createdAt: Date.now(),
  });
  return state;
}

function consumeState(state: string): PendingOAuthState | null {
  const entry = pendingStates.get(state);
  if (!entry) return null;
  pendingStates.delete(state);
  if (Date.now() - entry.createdAt > STATE_TTL_MS) return null;
  return entry;
}

/** Purge expired states (call lazily). */
function purgeExpiredStates(): void {
  const now = Date.now();
  for (const [key, entry] of pendingStates) {
    if (now - entry.createdAt > STATE_TTL_MS) {
      pendingStates.delete(key);
    }
  }
}

// ---------------------------------------------------------------------------
// Completed tokens store (in-memory, short-lived for frontend polling)
// ---------------------------------------------------------------------------

interface CompletedOAuth {
  token: string;
  provider: string;
  userId: string;
  createdAt: number;
}

const COMPLETED_TTL_MS = 5 * 60 * 1000; // 5 minutes
const completedTokens = new Map<string, CompletedOAuth>();

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

const initiateSchema = z.object({
  provider: z.string().min(1).max(64),
});

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export const channelOAuthRoutes = new Hono<AuthEnv>();

/**
 * POST /api/channel-oauth/initiate
 *
 * Generates an OAuth authorization URL for the given provider.
 * Returns { authorizeUrl, state } for the frontend to open in a popup.
 *
 * Requires authenticated session (user must be logged in).
 */
channelOAuthRoutes.post("/initiate", async (c) => {
  // Lazy purge
  if (pendingStates.size > 500) purgeExpiredStates();

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
  const state = createState(provider, user.id, callbackUrl);

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
channelOAuthRoutes.get("/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const errorParam = c.req.query("error");

  if (errorParam) {
    return c.html(callbackHtml("error", errorParam));
  }

  if (!code || !state) {
    return c.html(callbackHtml("error", "Missing code or state parameter"));
  }

  const pending = consumeState(state);
  if (!pending) {
    return c.html(callbackHtml("error", "Invalid or expired OAuth state"));
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
    completedTokens.set(state, {
      token: accessToken,
      provider: pending.provider,
      userId: pending.userId,
      createdAt: Date.now(),
    });

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
channelOAuthRoutes.get("/poll", async (c) => {
  // Lazy purge
  if (completedTokens.size > 500) {
    const now = Date.now();
    for (const [key, entry] of completedTokens) {
      if (now - entry.createdAt > COMPLETED_TTL_MS) completedTokens.delete(key);
    }
  }

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

  const completed = completedTokens.get(state);
  if (!completed) {
    return c.json({ status: "pending" });
  }

  // Ownership check: only the user who initiated the flow can retrieve the token
  if (completed.userId !== user.id) {
    return c.json({ status: "pending" });
  }

  if (Date.now() - completed.createdAt > COMPLETED_TTL_MS) {
    completedTokens.delete(state);
    return c.json({ status: "expired" });
  }

  // Consume the token (one-time read)
  completedTokens.delete(state);
  return c.json({ status: "completed", token: completed.token });
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
  const message =
    status === "success"
      ? `{ type: "wopr-oauth-callback", status: "success", state: ${JSON.stringify(payload)} }`
      : `{ type: "wopr-oauth-callback", status: "error", error: ${JSON.stringify(payload)} }`;

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

/** Reset all in-memory state. For testing only. */
export function resetChannelOAuthState(): void {
  pendingStates.clear();
  completedTokens.clear();
}
