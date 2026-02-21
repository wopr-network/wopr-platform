import { Hono } from "hono";
import { z } from "zod";
import type { AuthEnv } from "../../auth/index.js";
import { logger } from "../../config/logger.js";

export const channelTestRoutes = new Hono<AuthEnv>();

const testRequestSchema = z.object({
  credentials: z.record(z.string(), z.string()),
});

/**
 * POST /:pluginId/test
 *
 * Validates channel credentials against the provider API.
 * Requires authenticated session (user must be logged in).
 *
 * Body: { credentials: { botToken: "...", ... } }
 * Response: { success: true } or { success: false, error: "..." }
 */
channelTestRoutes.post("/:pluginId/test", async (c) => {
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

  // Validate pluginId — only known channel types
  const SUPPORTED_CHANNELS = ["discord", "slack", "telegram"];
  if (!SUPPORTED_CHANNELS.includes(pluginId)) {
    return c.json({ error: `Unsupported channel: ${pluginId}` }, 400);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const parsed = testRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid input", details: parsed.error.flatten().fieldErrors }, 400);
  }

  const { credentials } = parsed.data;

  try {
    const result = await testChannelCredentials(pluginId, credentials);
    if (result.success) {
      return c.json({ success: true });
    }
    return c.json({ success: false, error: result.error }, 200);
  } catch (err) {
    logger.error("Channel test failed", {
      pluginId,
      userId: user.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return c.json({ success: false, error: "Connection test failed unexpectedly" }, 200);
  }
});

// ---------------------------------------------------------------------------
// Provider-specific validation
// ---------------------------------------------------------------------------

interface TestResult {
  success: boolean;
  error?: string;
}

async function testChannelCredentials(pluginId: string, credentials: Record<string, string>): Promise<TestResult> {
  switch (pluginId) {
    case "discord":
      return testDiscord(credentials);
    case "slack":
      return testSlack(credentials);
    case "telegram":
      return testTelegram(credentials);
    default:
      return { success: false, error: `Unsupported channel: ${pluginId}` };
  }
}

async function testDiscord(credentials: Record<string, string>): Promise<TestResult> {
  const token = credentials.botToken;
  if (!token) {
    return { success: false, error: "Bot token is required" };
  }

  // Call Discord GET /users/@me to validate bot token
  const res = await fetch("https://discord.com/api/v10/users/@me", {
    headers: { Authorization: `Bot ${token}` },
    signal: AbortSignal.timeout(5000),
  });

  if (res.ok) {
    return { success: true };
  }

  if (res.status === 401) {
    return { success: false, error: "Invalid bot token. Check your token and try again." };
  }

  return { success: false, error: `Discord API returned ${res.status}` };
}

async function testSlack(credentials: Record<string, string>): Promise<TestResult> {
  const token = credentials.oauthToken;
  if (!token) {
    return { success: false, error: "OAuth token is required" };
  }

  // Call Slack auth.test to validate token
  const res = await fetch("https://slack.com/api/auth.test", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    signal: AbortSignal.timeout(5000),
  });

  if (!res.ok) {
    return { success: false, error: `Slack API returned ${res.status}` };
  }

  const data = (await res.json()) as { ok: boolean; error?: string };
  if (data.ok) {
    return { success: true };
  }

  return { success: false, error: `Slack error: ${data.error || "Unknown error"}` };
}

async function testTelegram(credentials: Record<string, string>): Promise<TestResult> {
  const token = credentials.botToken;
  if (!token) {
    return { success: false, error: "Bot token is required" };
  }

  // Call Telegram getMe to validate bot token
  const res = await fetch(`https://api.telegram.org/bot${encodeURIComponent(token)}/getMe`, {
    signal: AbortSignal.timeout(5000),
  });

  if (!res.ok) {
    if (res.status === 401 || res.status === 404) {
      return { success: false, error: "Invalid bot token. Check your token and try again." };
    }
    return { success: false, error: `Telegram API returned ${res.status}` };
  }

  const data = (await res.json()) as { ok: boolean; description?: string };
  if (data.ok) {
    return { success: true };
  }

  return { success: false, error: data.description || "Telegram validation failed" };
}

/** For testing: exported so tests can access it. */
export { testChannelCredentials };
