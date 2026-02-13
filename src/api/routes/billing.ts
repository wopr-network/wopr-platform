import type Database from "better-sqlite3";
import { Hono } from "hono";
import type Stripe from "stripe";
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

let deps: BillingRouteDeps | null = null;

/** Inject dependencies (call before serving). */
export function setBillingDeps(d: BillingRouteDeps): void {
  deps = d;
}

function getDeps(): BillingRouteDeps {
  if (!deps) {
    throw new Error("Billing routes not initialized — call setBillingDeps() first");
  }
  return deps;
}

export const billingRoutes = new Hono();

/**
 * POST /billing/checkout
 *
 * Create a Stripe Checkout session for a tenant.
 * Body: { tenant, priceId?, successUrl, cancelUrl }
 */
billingRoutes.post("/checkout", async (c) => {
  const { stripe, db, defaultPriceId } = getDeps();

  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const tenant = body.tenant as string | undefined;
  const priceId = (body.priceId as string | undefined) ?? defaultPriceId;
  const successUrl = body.successUrl as string | undefined;
  const cancelUrl = body.cancelUrl as string | undefined;

  if (!tenant || !priceId || !successUrl || !cancelUrl) {
    return c.json({ error: "Missing required fields: tenant, successUrl, cancelUrl" }, 400);
  }

  const tenantStore = new TenantCustomerStore(db);

  try {
    const session = await createCheckoutSession(stripe, tenantStore, {
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
billingRoutes.post("/portal", async (c) => {
  const { stripe, db } = getDeps();

  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const tenant = body.tenant as string | undefined;
  const returnUrl = body.returnUrl as string | undefined;

  if (!tenant || !returnUrl) {
    return c.json({ error: "Missing required fields: tenant, returnUrl" }, 400);
  }

  const tenantStore = new TenantCustomerStore(db);

  try {
    const session = await createPortalSession(stripe, tenantStore, { tenant, returnUrl });
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
 */
billingRoutes.post("/webhook", async (c) => {
  const { stripe, db, webhookSecret } = getDeps();

  const body = await c.req.text();
  const signature = c.req.header("stripe-signature");

  if (!signature) {
    return c.json({ error: "Missing stripe-signature header" }, 400);
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, signature, webhookSecret);
  } catch {
    return c.json({ error: "Invalid webhook signature" }, 400);
  }

  const tenantStore = new TenantCustomerStore(db);
  const result = handleWebhookEvent(tenantStore, event);

  return c.json(result, 200);
});
