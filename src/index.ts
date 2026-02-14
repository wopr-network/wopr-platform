import { serve } from "@hono/node-server";
import { app } from "./api/app.js";
import { config } from "./config/index.js";
import { logger } from "./config/logger.js";

const port = config.port;

// Global process-level error handlers to prevent crashes from unhandled errors.
// These handlers ensure the process logs critical errors and handles them gracefully.

// Handle unhandled promise rejections (async errors that weren't caught)
process.on("unhandledRejection", (reason, promise) => {
  logger.error("Unhandled promise rejection", {
    reason: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
    promise: String(promise),
  });
  // Don't exit — log and continue serving other tenants
});

// Handle uncaught exceptions (synchronous errors that weren't caught)
process.on("uncaughtException", (err, origin) => {
  logger.error("Uncaught exception", {
    error: err.message,
    stack: err.stack,
    origin,
  });
  // Uncaught exceptions leave the process in an undefined state.
  // Log the error, then exit after a short delay to allow logs to flush.
  setTimeout(() => {
    process.exit(1);
  }, 1000);
});

logger.info(`wopr-platform starting on port ${port}`);

serve({ fetch: app.fetch, port }, () => {
  logger.info(`wopr-platform listening on http://0.0.0.0:${port}`);
});
