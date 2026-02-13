import type Database from "better-sqlite3";
import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import type Stripe from "stripe";
import { z } from "zod";
import { logger } from "../../config/logger.js";
import { createCheckoutSession } from "../../monetization/stripe/checkout.js";
import { createPortalSession } from "../../monetization/stripe/portal.js";
import { TenantCustomerStore } from "../../monetization/stripe/tenant-store.js";
import { handleWebhookEvent } from "../../monetization/stripe/webhook.js";

export interface BillingRouteDeps {
  stripe: Stripe;
  db: Database.Database;
  webhookSecret: string;
  defaultPriceId?: string;
}

const FLEET_API_TOKEN = process.env.FLEET_API_TOKEN;

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

// -- Route factory ------------------------------------------------------------

let deps: BillingRouteDeps | null = null;
let tenantStore: TenantCustomerStore | null = null;

/** Inject dependencies (call before serving). */
export function setBillingDeps(d: BillingRouteDeps): void {
  deps = d;
  tenantStore = new TenantCustomerStore(d.db);
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

export const billingRoutes = new Hono();

// Auth — same token as fleet for checkout/portal (webhook uses Stripe signature)
if (!FLEET_API_TOKEN) {
  logger.warn("FLEET_API_TOKEN is not set — billing routes will reject all requests");
}

/**
 * POST /billing/checkout
 *
 * Create a Stripe Checkout session for a tenant.
 * Body: { tenant, priceId?, successUrl, cancelUrl }
 */
billingRoutes.post("/checkout", bearerAuth({ token: FLEET_API_TOKEN || "" }), async (c) => {
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
billingRoutes.post("/portal", bearerAuth({ token: FLEET_API_TOKEN || "" }), async (c) => {
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
