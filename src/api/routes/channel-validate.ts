import { Hono } from "hono";
import { z } from "zod";
import type { AuthEnv } from "../../auth/index.js";
import { logger } from "../../config/logger.js";

const channelValidateSchema = z.object({
  credentials: z.record(z.string(), z.string()),
});

export const channelValidateRoutes = new Hono<AuthEnv>();

/**
 * POST /:pluginId/test
 *
 * Validates channel credentials by calling the channel's API.
 * Returns { success: boolean, error?: string }.
 *
 * Requires authenticated session (resolveSessionUser runs on /api/*).
 *
 * SECURITY: Credentials are used for a single API probe and then discarded.
 * They are NEVER logged, NEVER persisted, NEVER returned in the response.
 */
channelValidateRoutes.post("/:pluginId/test", async (c) => {
  let user: { id: string } | undefined;
  try {
    user = c.get("user");
  } catch {
    // not set
  }
  if (!user) {
    return c.json({ error: "Authentication required" }, 401);
  }

  const pluginId = c.req.param("pluginId");

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const parsed = channelValidateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid input", details: parsed.error.flatten().fieldErrors }, 400);
  }

  const { credentials } = parsed.data;

  const result = await validateChannel(pluginId, credentials);

  logger.info("Channel credential validation", {
    pluginId,
    userId: user.id,
    success: result.success,
    // NEVER log credential values
  });

  return c.json(result);
});

// ---------------------------------------------------------------------------
// Channel-specific validation probes
// ---------------------------------------------------------------------------

interface ValidationResult {
  success: boolean;
  error?: string;
}

const PROBE_TIMEOUT_MS = 5000;

async function validateChannel(pluginId: string, credentials: Record<string, string>): Promise<ValidationResult> {
  switch (pluginId) {
    case "discord":
      return validateDiscord(credentials);
    case "telegram":
      return validateTelegram(credentials);
    case "slack":
      return validateSlack(credentials);
    // Signal, WhatsApp, MS Teams: no simple API probe available.
    // Format validation is handled client-side; server returns success.
    default:
      return { success: true };
  }
}

async function validateDiscord(credentials: Record<string, string>): Promise<ValidationResult> {
  const token = credentials.discord_bot_token;
  if (!token) {
    return { success: false, error: "Discord bot token is required" };
  }

  try {
    const res = await fetch("https://discord.com/api/v10/users/@me", {
      headers: { Authorization: `Bot ${token}` },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });

    if (res.ok) {
      return { success: true };
    }
    if (res.status === 401) {
      return { success: false, error: "Invalid Discord bot token" };
    }
    return { success: false, error: `Discord API returned ${res.status}` };
  } catch (err) {
    return handleFetchError(err, "Discord");
  }
}

async function validateTelegram(credentials: Record<string, string>): Promise<ValidationResult> {
  const token = credentials.telegram_bot_token;
  if (!token) {
    return { success: false, error: "Telegram bot token is required" };
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });

    if (!res.ok) {
      return { success: false, error: "Invalid Telegram bot token" };
    }

    const data = (await res.json()) as { ok: boolean; description?: string };
    if (data.ok) {
      return { success: true };
    }
    return { success: false, error: "Invalid Telegram bot token" };
  } catch (err) {
    return handleFetchError(err, "Telegram");
  }
}

async function validateSlack(credentials: Record<string, string>): Promise<ValidationResult> {
  const token = credentials.slack_bot_token;
  if (!token) {
    return { success: false, error: "Slack bot token is required" };
  }

  try {
    const res = await fetch("https://slack.com/api/auth.test", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });

    if (!res.ok) {
      return { success: false, error: `Slack API returned ${res.status}` };
    }

    const data = (await res.json()) as { ok: boolean; error?: string };
    if (data.ok) {
      return { success: true };
    }
    return { success: false, error: `Slack error: ${data.error || "invalid_auth"}` };
  } catch (err) {
    return handleFetchError(err, "Slack");
  }
}

function handleFetchError(err: unknown, provider: string): ValidationResult {
  if (err instanceof DOMException && err.name === "AbortError") {
    return { success: false, error: `${provider} API request timed out. Please try again.` };
  }
  return { success: false, error: `Could not reach ${provider}. Check your connection.` };
}
