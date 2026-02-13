import { serve } from "@hono/node-server";
import { app } from "./api/app.js";
import { config } from "./config/index.js";
import { logger } from "./config/logger.js";

const port = config.port;

logger.info(`wopr-platform starting on port ${port}`);

serve({ fetch: app.fetch, port }, () => {
  logger.info(`wopr-platform listening on http://0.0.0.0:${port}`);
});
