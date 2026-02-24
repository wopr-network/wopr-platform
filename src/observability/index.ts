/**
 * Observability — Sentry error tracking, metrics, alerts, health dashboard.
 */

export type { AlertCheckResult, AlertDefinition } from "./alerts.js";
export { AlertChecker, buildAlerts } from "./alerts.js";
export type { AdminHealthDeps } from "./health-dashboard.js";
export { createAdminHealthHandler } from "./health-dashboard.js";
export type { WindowResult } from "./metrics.js";
export { MetricsCollector } from "./metrics.js";
export { captureError, captureMessage, initSentry } from "./sentry.js";
export type { SystemResourceSnapshot, SystemResourceThresholds } from "./system-resources.js";
export { SystemResourceMonitor } from "./system-resources.js";
