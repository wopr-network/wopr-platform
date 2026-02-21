import * as Sentry from "@sentry/node";
import { config } from "../config/index.js";

/**
 * Initialize Sentry SDK. Must be called BEFORE any other imports
 * that might throw (i.e., at the very top of src/index.ts).
 *
 * Reads SENTRY_DSN from env. If absent, Sentry is disabled (no-op).
 */
export function initSentry(): void {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;

  Sentry.init({
    dsn,
    environment: config.nodeEnv,
    release: process.env.SENTRY_RELEASE ?? undefined,
    // Sample 100% of errors, 10% of transactions in production
    tracesSampleRate: config.nodeEnv === "production" ? 0.1 : 1.0,
    // Deduplicate — only alert on *new* error types
    integrations: [Sentry.dedupeIntegration()],
    // Scrub sensitive data from breadcrumbs
    beforeBreadcrumb(breadcrumb) {
      if (breadcrumb.category === "http" && breadcrumb.data?.url) {
        // Strip query params that might contain tokens
        try {
          const url = new URL(breadcrumb.data.url as string);
          url.search = "";
          breadcrumb.data.url = url.toString();
        } catch {
          // leave as-is if URL parsing fails
        }
      }
      return breadcrumb;
    },
  });
}

/**
 * Tag the current Sentry scope with request-level context.
 * Call this from Hono middleware or error handlers.
 */
export function tagSentryContext(tags: { orgId?: string; instanceId?: string; route?: string }): void {
  Sentry.setTags({
    ...(tags.orgId && { orgId: tags.orgId }),
    ...(tags.instanceId && { instanceId: tags.instanceId }),
    ...(tags.route && { route: tags.route }),
  });
}

/**
 * Capture an exception in Sentry with optional WOPR-specific tags.
 */
export function captureError(
  error: unknown,
  context?: {
    orgId?: string;
    instanceId?: string;
    route?: string;
    extra?: Record<string, unknown>;
  },
): void {
  Sentry.captureException(error, {
    tags: {
      ...(context?.orgId && { orgId: context.orgId }),
      ...(context?.instanceId && { instanceId: context.instanceId }),
      ...(context?.route && { route: context.route }),
    },
    extra: context?.extra,
  });
}
