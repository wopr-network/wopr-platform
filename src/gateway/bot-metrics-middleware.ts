import type { Context, Next } from "hono";
import type { BotMetricsTracker } from "./bot-metrics-tracker.js";
import type { GatewayAuthEnv } from "./service-key-auth.js";

export function botMetricsMiddleware(tracker: BotMetricsTracker) {
  return async (c: Context<GatewayAuthEnv>, next: Next) => {
    const tenant = c.get("gatewayTenant");
    const instanceId = tenant?.instanceId;

    if (!instanceId) {
      return next();
    }

    const start = performance.now();
    await next();
    const elapsed = Math.round(performance.now() - start);

    tracker.recordRequest(instanceId, elapsed);

    const status = c.res.status;
    if (status >= 400) {
      tracker.recordError(instanceId);
    }
  };
}
