import * as Sentry from "@sentry/node";

let initialized = false;

/**
 * Initialize Sentry error tracking. No-ops when dsn is absent or empty.
 */
export function initSentry(dsn?: string): void {
  if (!dsn) {
    initialized = false;
    return;
  }

  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? "development",
    tracesSampleRate: 0,
    beforeBreadcrumb(breadcrumb) {
      // Scrub sensitive data from breadcrumbs
      if (breadcrumb.data) {
        const data = breadcrumb.data as Record<string, unknown>;
        for (const key of Object.keys(data)) {
          if (/key|token|secret|password|auth/i.test(key)) {
            data[key] = "[REDACTED]";
          }
        }
      }
      return breadcrumb;
    },
  });

  initialized = true;
}

/**
 * Capture an error in Sentry with optional context tags.
 * Safe to call even when Sentry is not initialized.
 */
export function captureError(error: unknown, context?: Record<string, string>): void {
  if (!initialized) return;

  Sentry.captureException(error, {
    tags: context,
  });
}

/**
 * Capture a message in Sentry.
 * Safe to call even when Sentry is not initialized.
 */
export function captureMessage(message: string, level?: "info" | "warning" | "error"): void {
  if (!initialized) return;

  Sentry.captureMessage(message, level ?? "info");
}
