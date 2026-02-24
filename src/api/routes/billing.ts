import crypto from "node:crypto";
import type { Context } from "hono";
import { Hono } from "hono";
import type Stripe from "stripe";
import { z } from "zod";
import { buildTokenMetadataMap, scopedBearerAuthWithTenant } from "../../auth/index.js";
import { logger } from "../../config/logger.js";
import type { DrizzleDb } from "../../db/index.js";
import type { IAffiliateRepository } from "../../monetization/affiliate/drizzle-affiliate-repository.js";
import { CreditLedger } from "../../monetization/credits/credit-ledger.js";
import { MeterAggregator } from "../../monetization/metering/aggregator.js";
import { PayRamChargeStore } from "../../monetization/payram/charge-store.js";
import { createPayRamCheckout, MIN_PAYMENT_USD } from "../../monetization/payram/checkout.js";
import { createPayRamClient, loadPayRamConfig } from "../../monetization/payram/client.js";
import type { PayRamWebhookPayload } from "../../monetization/payram/types.js";
import { handlePayRamWebhook } from "../../monetization/payram/webhook.js";
import { createCreditCheckoutSession } from "../../monetization/stripe/checkout.js";
import type { CreditPriceMap } from "../../monetization/stripe/credit-prices.js";
import { loadCreditPriceMap } from "../../monetization/stripe/credit-prices.js";
import { detachPaymentMethod, PaymentMethodOwnershipError } from "../../monetization/stripe/payment-methods.js";
import { createPortalSession } from "../../monetization/stripe/portal.js";
import { createSetupIntent } from "../../monetization/stripe/setup-intent.js";
import { TenantCustomerStore } from "../../monetization/stripe/tenant-store.js";
import { handleWebhookEvent } from "../../monetization/stripe/webhook.js";
import type { IWebhookSeenRepository } from "../../monetization/webhook-seen-repository.js";
import type { ISigPenaltyRepository } from "../sig-penalty-repository.js";

export interface BillingRouteDeps {
  stripe: Stripe;
  db: DrizzleDb;
  webhookSecret: string;
  sigPenaltyRepo: ISigPenaltyRepository;
  /** Replay guard for Stripe webhook deduplication. */
  replayGuard?: IWebhookSeenRepository;
  /** Replay guard for PayRam webhook deduplication. */
  payramReplayGuard?: IWebhookSeenRepository;
  affiliateRepo: IAffiliateRepository;
}

const metadataMap = buildTokenMetadataMap();
const adminAuth = scopedBearerAuthWithTenant(metadataMap, "admin");

// -- Signature failure penalty tracking (WOP-477, WOP-927) -------------------

/**
 * Extract IP from request (same logic as rate-limit.ts defaultKeyGenerator).
 */
function getClientIp(c: Context): string {
  const xff = c.req.header("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const incoming = (c.env as Record<string, unknown>)?.incoming as { socket?: { remoteAddress?: string } } | undefined;
  return incoming?.socket?.remoteAddress ?? "unknown";
}

// -- Zod schemas for input validation ----------------------------------------

const tenantIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_-]+$/);
const urlSchema = z.string().url().max(2048);

const creditCheckoutBodySchema = z.object({
  tenant: tenantIdSchema,
  priceId: z.string().min(1).max(256),
  successUrl: urlSchema,
  cancelUrl: urlSchema,
});

const portalBodySchema = z.object({
  tenant: tenantIdSchema,
  returnUrl: urlSchema,
});

const identifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9_-]+$/i);

const usageQuerySchema = z.object({
  tenant: tenantIdSchema,
  capability: identifierSchema.optional(),
  provider: identifierSchema.optional(),
  startDate: z.coerce.number().int().positive().optional(),
  endDate: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(1000).optional(),
});

const paymentMethodIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^pm_[a-zA-Z0-9_]+$/);

const detachPaymentMethodParamsSchema = z.object({
  id: paymentMethodIdSchema,
});

const cryptoCheckoutBodySchema = z.object({
  tenant: tenantIdSchema,
  amountUsd: z.number().min(MIN_PAYMENT_USD).max(10000),
});

const payramWebhookBodySchema = z.object({
  reference_id: z.string().min(1).max(256),
  invoice_id: z.string().optional(),
  status: z.enum(["OPEN", "VERIFYING", "FILLED", "OVER_FILLED", "PARTIALLY_FILLED", "CANCELLED"]),
  amount: z.string(),
  currency: z.string(),
  filled_amount: z.string(),
});

// -- Route factory ------------------------------------------------------------

let deps: BillingRouteDeps | null = null;
let tenantStore: TenantCustomerStore | null = null;
let creditLedger: CreditLedger | null = null;
let meterAggregator: MeterAggregator | null = null;
let priceMap: CreditPriceMap | null = null;
let affiliateRepo: IAffiliateRepository | null = null;

/** Reject webhook events with timestamps older than 5 minutes (in seconds). */
const WEBHOOK_TIMESTAMP_TOLERANCE = 300;

let payramClient: import("payram").Payram | null = null;
let payramChargeStore: PayRamChargeStore | null = null;

/** Inject dependencies (call before serving). */
export function setBillingDeps(d: BillingRouteDeps): void {
  deps = d;
  tenantStore = new TenantCustomerStore(d.db);
  creditLedger = new CreditLedger(d.db);
  meterAggregator = new MeterAggregator(d.db);
  priceMap = loadCreditPriceMap();
  affiliateRepo = d.affiliateRepo;

  // PayRam initialization (optional — only if env vars are set)
  const payramConfig = loadPayRamConfig();
  if (payramConfig) {
    payramClient = createPayRamClient(payramConfig);
    payramChargeStore = new PayRamChargeStore(d.db);
  } else {
    payramClient = null;
    payramChargeStore = null;
  }
}

function getAffiliateRepo(): IAffiliateRepository {
  if (!affiliateRepo) {
    throw new Error("Billing routes not initialized — call setBillingDeps() first");
  }
  return affiliateRepo;
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

function getCreditLedger(): CreditLedger {
  if (!creditLedger) {
    throw new Error("Billing routes not initialized — call setBillingDeps() first");
  }
  return creditLedger;
}

function getMeterAggregator(): MeterAggregator {
  if (!meterAggregator) {
    throw new Error("Billing routes not initialized — call setBillingDeps() first");
  }
  return meterAggregator;
}

// BOUNDARY(WOP-805): REST is the correct layer for billing routes.
// - /billing/webhook: Stripe signature verification (raw HTTP, not tRPC)
// - /billing/crypto/*: PayRam webhook + checkout (external service signatures)
// - /billing/setup-intent: returns Stripe.js clientSecret (REST is simpler)
// - /billing/payment-methods/:id: Stripe detach (REST for now)
// - /billing/credits/checkout and /billing/portal: have tRPC mirrors;
//   keep REST until the UI fully migrates to tRPC (WOP-810+).
export const billingRoutes = new Hono();

// Auth — admin scope required for billing operations (webhook uses Stripe signature)
if (metadataMap.size === 0) {
  logger.warn("No API tokens configured — billing routes will reject all requests");
}

/**
 * POST /billing/credits/checkout
 *
 * Create a Stripe Checkout session for a one-time credit purchase.
 * Body: { tenant, priceId, successUrl, cancelUrl }
 */
billingRoutes.post("/credits/checkout", adminAuth, async (c) => {
  const { stripe } = getDeps();
  const store = getTenantStore();

  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const parsed = creditCheckoutBodySchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid input", details: parsed.error.flatten().fieldErrors }, 400);
  }

  const { tenant, priceId, successUrl, cancelUrl } = parsed.data;

  try {
    const session = await createCreditCheckoutSession(stripe, store, {
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
 * POST /billing/setup-intent
 *
 * Create a Stripe SetupIntent for saving a payment method.
 * Tenant is resolved from the auth token context (consistent with DELETE /payment-methods/:id).
 * Returns: { clientSecret }
 */
billingRoutes.post("/setup-intent", adminAuth, async (c) => {
  const { stripe } = getDeps();
  const store = getTenantStore();

  const tokenTenantId = c.get("tokenTenantId");
  if (!tokenTenantId) {
    return c.json({ error: "Missing tenant" }, 400);
  }

  const parsedTenant = tenantIdSchema.safeParse(tokenTenantId);
  if (!parsedTenant.success) {
    return c.json({ error: "Invalid tenant" }, 400);
  }

  try {
    const intent = await createSetupIntent(stripe, store, { tenant: parsedTenant.data });
    if (!intent.client_secret) {
      return c.json({ error: "Failed to create setup intent" }, 500);
    }
    return c.json({ clientSecret: intent.client_secret });
  } catch (err) {
    const message = err instanceof Error ? err.message : "SetupIntent creation failed";
    return c.json({ error: message }, 500);
  }
});

/**
 * DELETE /billing/payment-methods/:id
 *
 * Detach a payment method from the tenant's Stripe customer.
 */
billingRoutes.delete("/payment-methods/:id", adminAuth, async (c) => {
  const { stripe } = getDeps();
  const store = getTenantStore();

  const id = c.req.param("id");
  const parsedId = detachPaymentMethodParamsSchema.safeParse({ id });
  if (!parsedId.success) {
    return c.json({ error: "Invalid payment method ID" }, 400);
  }

  // Get tenant from query param or token
  const tenant = c.req.query("tenant");
  const tokenTenantId = c.get("tokenTenantId");

  if (tokenTenantId && tenant && tenant !== tokenTenantId) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const effectiveTenant = tokenTenantId ?? tenant;

  if (!effectiveTenant) {
    return c.json({ error: "Missing tenant" }, 400);
  }

  // Validate tenant format
  const parsedTenant = tenantIdSchema.safeParse(effectiveTenant);
  if (!parsedTenant.success) {
    return c.json({ error: "Invalid tenant" }, 400);
  }

  try {
    await detachPaymentMethod(stripe, store, {
      tenant: parsedTenant.data,
      paymentMethodId: parsedId.data.id,
    });
    return c.json({ removed: true });
  } catch (err) {
    if (err instanceof PaymentMethodOwnershipError) {
      return c.json({ error: err.message }, 403);
    }
    const message = err instanceof Error ? err.message : "Failed to remove payment method";
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
  const { stripe, webhookSecret, sigPenaltyRepo } = getDeps();
  const ip = getClientIp(c);
  const now = Date.now();

  // Check if this IP is currently in penalty backoff
  const penalty = sigPenaltyRepo.get(ip, "stripe");
  if (penalty && now < penalty.blockedUntil) {
    const retryAfterSec = Math.ceil((penalty.blockedUntil - now) / 1000);
    c.header("Retry-After", String(retryAfterSec));
    return c.json({ error: "Too many failed webhook signature attempts" }, 429);
  }

  const body = await c.req.text();
  const signature = c.req.header("stripe-signature");

  if (!signature) {
    return c.json({ error: "Missing stripe-signature header" }, 400);
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, signature, webhookSecret, WEBHOOK_TIMESTAMP_TOLERANCE);
    // Clear any stale penalties on successful verification (WOP-477)
    sigPenaltyRepo.clear(ip, "stripe");
  } catch (err) {
    // Track signature failure for exponential backoff (WOP-477)
    const updated = sigPenaltyRepo.recordFailure(ip, "stripe");

    logger.error("Webhook signature verification failed", {
      error: err instanceof Error ? err.message : String(err),
      ip,
      consecutiveFailures: updated.failures,
    });
    return c.json({ error: "Invalid webhook signature" }, 400);
  }

  const store = getTenantStore();
  const ledger = getCreditLedger();
  const result = handleWebhookEvent(
    {
      tenantStore: store,
      creditLedger: ledger,
      priceMap: priceMap ?? undefined,
      replayGuard: getDeps().replayGuard,
      affiliateRepo: getDeps().affiliateRepo,
    },
    event,
  );

  if (result.duplicate) {
    logger.warn("Webhook replay attempt detected", {
      eventId: event.id,
      eventType: event.type,
      ip: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? "unknown",
    });
  }

  return c.json(result, 200);
});

/**
 * POST /billing/crypto/checkout
 *
 * Create a PayRam payment session for a one-time crypto credit purchase.
 * Body: { tenant, amountUsd }
 */
billingRoutes.post("/crypto/checkout", adminAuth, async (c) => {
  if (!payramClient || !payramChargeStore) {
    return c.json({ error: "Crypto payments not configured" }, 503);
  }

  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const parsed = cryptoCheckoutBodySchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid input", details: parsed.error.flatten().fieldErrors }, 400);
  }

  try {
    const result = await createPayRamCheckout(payramClient, payramChargeStore, parsed.data);
    return c.json({ url: result.url, referenceId: result.referenceId });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Crypto checkout failed";
    return c.json({ error: message }, 500);
  }
});

/**
 * POST /billing/crypto/webhook
 *
 * PayRam webhook endpoint. Verifies the API key and processes payment events.
 * Note: No bearer auth — webhook uses PayRam API key verification.
 */
billingRoutes.post("/crypto/webhook", async (c) => {
  if (!payramChargeStore) {
    return c.json({ error: "Crypto payments not configured" }, 503);
  }

  // Verify the webhook is from our PayRam instance via API-Key header.
  const payramApiKey = process.env.PAYRAM_API_KEY;
  if (!payramApiKey) {
    return c.json({ error: "PayRam not configured" }, 503);
  }

  const incomingKey = c.req.header("API-Key");
  const incomingBuf = incomingKey ? Buffer.from(incomingKey) : null;
  const expectedBuf = Buffer.from(payramApiKey);
  if (!incomingBuf || incomingBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(incomingBuf, expectedBuf)) {
    logger.error("PayRam webhook API key verification failed");
    return c.json({ error: "Unauthorized" }, 401);
  }

  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ received: false }, 400);
  }

  const parsed = payramWebhookBodySchema.safeParse(body);
  if (!parsed.success) {
    logger.error("PayRam webhook payload validation failed", {
      errors: parsed.error.flatten().fieldErrors,
    });
    return c.json({ received: false }, 400);
  }

  const ledger = getCreditLedger();
  const result = handlePayRamWebhook(
    {
      chargeStore: payramChargeStore,
      creditLedger: ledger,
      replayGuard: getDeps().payramReplayGuard,
    },
    parsed.data as PayRamWebhookPayload,
  );

  if (result.duplicate) {
    logger.warn("PayRam webhook replay attempt detected", {
      referenceId: parsed.data.reference_id,
      status: parsed.data.status,
    });
  }

  // PayRam expects { received: true } as acknowledgement.
  return c.json({ received: result.handled }, 200);
});

/**
 * GET /billing/usage
 *
 * Query current period usage by capability/provider for a tenant.
 * Query params: tenant (required), capability, provider, startDate, endDate, limit
 */
billingRoutes.get("/usage", adminAuth, async (c) => {
  const aggregator = getMeterAggregator();

  const requestedTenant = c.req.query("tenant");
  const tokenTenantId = c.get("tokenTenantId");
  if (tokenTenantId && requestedTenant && requestedTenant !== tokenTenantId) {
    return c.json({ error: "Forbidden" }, 403);
  }

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
    logger.error("Failed to query usage", { error: err });
    return c.json({ error: "Internal server error" }, 500);
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

  const requestedTenant = c.req.query("tenant");
  const tokenTenantId = c.get("tokenTenantId");
  if (tokenTenantId && requestedTenant && requestedTenant !== tokenTenantId) {
    return c.json({ error: "Forbidden" }, 403);
  }

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
    logger.error("Failed to query usage summary", { error: err });
    return c.json({ error: "Internal server error" }, 500);
  }
});

const recordReferralBodySchema = z.object({
  code: z
    .string()
    .min(1)
    .max(10)
    .regex(/^[a-z0-9]+$/),
  referredTenantId: tenantIdSchema,
});

/**
 * GET /billing/affiliate
 *
 * Returns the authenticated user's affiliate code, link, and stats.
 * Lazily generates a code on first request.
 * Query param: tenant (required)
 */
billingRoutes.get("/affiliate", adminAuth, (c) => {
  const tokenTenantId = c.get("tokenTenantId");
  const tenant = tokenTenantId ?? c.req.query("tenant");

  if (!tenant) {
    return c.json({ error: "Missing tenant" }, 400);
  }

  const parsedTenant = tenantIdSchema.safeParse(tenant);
  if (!parsedTenant.success) {
    return c.json({ error: "Invalid tenant" }, 400);
  }

  try {
    const repo = getAffiliateRepo();
    const stats = repo.getStats(parsedTenant.data);
    return c.json(stats);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to get affiliate info";
    return c.json({ error: message }, 500);
  }
});

/**
 * POST /billing/affiliate/record-referral
 *
 * Record a referral attribution when a new user signs up with a ref code.
 * Body: { code, referredTenantId }
 * Called internally during signup flow.
 */
billingRoutes.post("/affiliate/record-referral", adminAuth, async (c) => {
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const parsed = recordReferralBodySchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid input", details: parsed.error.flatten().fieldErrors }, 400);
  }

  const { code, referredTenantId } = parsed.data;

  try {
    const repo = getAffiliateRepo();
    const codeRecord = repo.getByCode(code);
    if (!codeRecord) {
      return c.json({ error: "Invalid referral code" }, 404);
    }

    const isNew = repo.recordReferral(codeRecord.tenantId, referredTenantId, code);
    return c.json({ recorded: isNew, referrer: codeRecord.tenantId });
  } catch (err) {
    if (err instanceof Error && err.message.includes("Self-referral")) {
      return c.json({ error: "Self-referral is not allowed" }, 400);
    }
    const message = err instanceof Error ? err.message : "Failed to record referral";
    return c.json({ error: message }, 500);
  }
});
