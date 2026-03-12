import { createChannelValidateRoutes } from "@wopr-network/platform-core/api/routes/channel-validate";
import type { AuthEnv } from "@wopr-network/platform-core/auth";
import { logger } from "@wopr-network/platform-core/config/logger";
import { Hono } from "hono";

// Re-export factory from core
export { createChannelValidateRoutes } from "@wopr-network/platform-core/api/routes/channel-validate";

/** Pre-built channel validation routes with platform logger. */
export const channelValidateRoutes = new Hono<AuthEnv>();
channelValidateRoutes.route("/", createChannelValidateRoutes(logger));
