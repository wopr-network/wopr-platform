import type Database from "better-sqlite3";
import { Hono } from "hono";
import type Stripe from "stripe";
import { z } from "zod";
import { buildTokenMap, scopedBearerAuth } from "../../auth/index.js";
import { logger } from "../../config/logger.js";
import { MeterAggregator } from "../../monetization/metering/aggregator.js";
import { createCheckoutSession } from "../../monetization/stripe/checkout.js";
import { createPortalSession } from "../../monetization/stripe/portal.js";
import { TenantCustomerStore } from "../../monetization/stripe/tenant-store.js";
import { StripeUsageReporter } from "../../monetization/stripe/usage-reporter.js";
import { handleWebhookEvent } from "../../monetization/stripe/webhook.js";

export interface BillingRouteDeps {
  stripe: Stripe;
  db: Database.Database;
  webhookSecret: string;
  defaultPriceId?: string;
}

const tokenMap = buildTokenMap();
const adminAuth = scopedBearerAuth(tokenMap, "admin");

// -- Zod schemas for input validation ----------------------------------------

const tenantIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_-]+$/);
const urlSchema = z.string().url().max(2048);

const checkoutBodySchema = z.object({
  tenant: tenantIdSchema,
  priceId: z.string().min(1).max(256).optional(),
  successUrl: urlSchema,
  cancelUrl: urlSchema,
});

const portalBodySchema = z.object({
  tenant: tenantIdSchema,
  returnUrl: urlSchema,
});

const usageQuerySchema = z.object({
  tenant: tenantIdSchema,
  capability: z.string().min(1).max(128).optional(),
  provider: z.string().min(1).max(128).optional(),
  startDate: z.coerce.number().int().positive().optional(),
  endDate: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(1000).optional(),
});

// -- Route factory ------------------------------------------------------------

let deps: BillingRouteDeps | null = null;
let tenantStore: TenantCustomerStore | null = null;
let meterAggregator: MeterAggregator | null = null;
let usageReporter: StripeUsageReporter | null = null;

/** Inject dependencies (call before serving). */
export function setBillingDeps(d: BillingRouteDeps): void {
  deps = d;
  tenantStore = new TenantCustomerStore(d.db);
  meterAggregator = new MeterAggregator(d.db);
  usageReporter = new StripeUsageReporter(d.db, d.stripe, tenantStore);
}

function getDeps(): BillingRouteDeps {
  if (!deps) {
    throw new Error("Billing routes not initialized — call setBillingDeps() first");
  }
  return deps;
}

function getTenantStore(): TenantCustomerStore {
  if (!tenantStore) {
    throw new Error("Billing routes not initialized — call setBillingDeps() first");
  }
  return tenantStore;
}

function getMeterAggregator(): MeterAggregator {
  if (!meterAggregator) {
    throw new Error("Billing routes not initialized — call setBillingDeps() first");
  }
  return meterAggregator;
}

function getUsageReporter(): StripeUsageReporter {
  if (!usageReporter) {
    throw new Error("Billing routes not initialized — call setBillingDeps() first");
  }
  return usageReporter;
}

export const billingRoutes = new Hono();

// Auth — admin scope required for billing operations (webhook uses Stripe signature)
if (tokenMap.size === 0) {
  logger.warn("No API tokens configured — billing routes will reject all requests");
}

/**
 * POST /billing/checkout
 *
 * Create a Stripe Checkout session for a tenant.
 * Body: { tenant, priceId?, successUrl, cancelUrl }
 */
billingRoutes.post("/checkout", adminAuth, async (c) => {
  const { stripe, defaultPriceId } = getDeps();
  const store = getTenantStore();

  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const parsed = checkoutBodySchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid input", details: parsed.error.flatten().fieldErrors }, 400);
  }

  const { tenant, successUrl, cancelUrl } = parsed.data;
  const priceId = parsed.data.priceId ?? defaultPriceId;

  if (!priceId) {
    return c.json({ error: "Missing required fields: tenant, priceId, successUrl, cancelUrl" }, 400);
  }

  try {
    const session = await createCheckoutSession(stripe, store, {
      tenant,
      priceId,
      successUrl,
      cancelUrl,
    });

    return c.json({ url: session.url, sessionId: session.id });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Checkout session creation failed";
    return c.json({ error: message }, 500);
  }
});

/**
 * POST /billing/portal
 *
 * Create a Stripe Customer Portal session.
 * Body: { tenant, returnUrl }
 */
billingRoutes.post("/portal", adminAuth, async (c) => {
  const { stripe } = getDeps();
  const store = getTenantStore();

  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const parsed = portalBodySchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid input", details: parsed.error.flatten().fieldErrors }, 400);
  }

  const { tenant, returnUrl } = parsed.data;

  try {
    const session = await createPortalSession(stripe, store, { tenant, returnUrl });
    return c.json({ url: session.url });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Portal session creation failed";
    return c.json({ error: message }, 500);
  }
});

/**
 * POST /billing/webhook
 *
 * Stripe webhook endpoint. Verifies the signature and processes events.
 * Note: No bearer auth — webhook uses Stripe signature verification.
 */
billingRoutes.post("/webhook", async (c) => {
  const { stripe, webhookSecret } = getDeps();

  const body = await c.req.text();
  const signature = c.req.header("stripe-signature");

  if (!signature) {
    return c.json({ error: "Missing stripe-signature header" }, 400);
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, signature, webhookSecret);
  } catch (err) {
    logger.error("Webhook signature verification failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return c.json({ error: "Invalid webhook signature" }, 400);
  }

  const store = getTenantStore();
  const result = handleWebhookEvent(store, event);

  return c.json(result, 200);
});

/**
 * GET /billing/usage
 *
 * Query current period usage by capability/provider for a tenant.
 * Query params: tenant (required), capability, provider, startDate, endDate, limit
 */
billingRoutes.get("/usage", adminAuth, async (c) => {
  const aggregator = getMeterAggregator();

  const params = {
    tenant: c.req.query("tenant"),
    capability: c.req.query("capability"),
    provider: c.req.query("provider"),
    startDate: c.req.query("startDate"),
    endDate: c.req.query("endDate"),
    limit: c.req.query("limit"),
  };

  const parsed = usageQuerySchema.safeParse(params);

  if (!parsed.success) {
    return c.json({ error: "Invalid query parameters", details: parsed.error.flatten().fieldErrors }, 400);
  }

  const { tenant, startDate, endDate, limit } = parsed.data;

  try {
    const summaries = aggregator.querySummaries(tenant, {
      since: startDate,
      until: endDate,
      limit,
    });

    // Filter by capability and provider if specified
    let filtered = summaries;
    if (parsed.data.capability) {
      filtered = filtered.filter((s) => s.capability === parsed.data.capability);
    }
    if (parsed.data.provider) {
      filtered = filtered.filter((s) => s.provider === parsed.data.provider);
    }

    return c.json({ tenant, usage: filtered });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to query usage";
    return c.json({ error: message }, 500);
  }
});

/**
 * GET /billing/usage/summary
 *
 * Get total spend for current period (or specified date range).
 * Query params: tenant (required), startDate (optional)
 */
billingRoutes.get("/usage/summary", adminAuth, async (c) => {
  const aggregator = getMeterAggregator();

  const params = {
    tenant: c.req.query("tenant"),
    startDate: c.req.query("startDate"),
  };

  const parsed = usageQuerySchema.safeParse(params);

  if (!parsed.success) {
    return c.json({ error: "Invalid query parameters", details: parsed.error.flatten().fieldErrors }, 400);
  }

  const { tenant, startDate } = parsed.data;

  try {
    // Default to start of current billing period (beginning of current hour)
    const since = startDate ?? Math.floor(Date.now() / 3_600_000) * 3_600_000;
    const total = aggregator.getTenantTotal(tenant, since);

    return c.json({
      tenant,
      period_start: since,
      total_cost: total.totalCost,
      total_charge: total.totalCharge,
      event_count: total.eventCount,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to query usage summary";
    return c.json({ error: message }, 500);
  }
});

/**
 * GET /billing/usage/history
 *
 * Get historical billing data (reports sent to Stripe).
 * Query params: tenant (required), limit (optional, default 100, max 1000)
 */
billingRoutes.get("/usage/history", adminAuth, async (c) => {
  const reporter = getUsageReporter();

  const params = {
    tenant: c.req.query("tenant"),
    limit: c.req.query("limit"),
  };

  const parsed = usageQuerySchema.safeParse(params);

  if (!parsed.success) {
    return c.json({ error: "Invalid query parameters", details: parsed.error.flatten().fieldErrors }, 400);
  }

  const { tenant, limit } = parsed.data;

  try {
    const reports = reporter.queryReports(tenant, { limit });
    return c.json({ tenant, reports });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to query billing history";
    return c.json({ error: message }, 500);
  }
});
