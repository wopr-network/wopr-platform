import { getClientIpFromContext } from "@wopr-network/platform-core/api/middleware/get-client-ip";
import type { ISigPenaltyRepository } from "@wopr-network/platform-core/api/sig-penalty-repository";
import { buildTokenMetadataMap, scopedBearerAuthWithTenant } from "@wopr-network/platform-core/auth";
import type { ICryptoChargeRepository, IWebhookSeenRepository } from "@wopr-network/platform-core/billing";
import {
  CryptoServiceClient,
  handleCryptoWebhook,
  type IPaymentProcessor,
  loadCryptoConfig,
  MIN_PAYMENT_USD,
  PaymentMethodOwnershipError,
  verifyCryptoWebhookSignature,
} from "@wopr-network/platform-core/billing";
import { logger } from "@wopr-network/platform-core/config/logger";
import type { ILedger } from "@wopr-network/platform-core/credits";
import { Credit } from "@wopr-network/platform-core/credits";
import type { IMeterAggregator } from "@wopr-network/platform-core/metering";
import type { IAffiliateRepository } from "@wopr-network/platform-core/monetization/affiliate/drizzle-affiliate-repository";
import { assertSafeRedirectUrl } from "@wopr-network/platform-core/security";
import { Hono } from "hono";
import { z } from "zod";

export interface BillingRouteDeps {
  processor: IPaymentProcessor;
  creditLedger: ILedger;
  meterAggregator: IMeterAggregator;
  sigPenaltyRepo: ISigPenaltyRepository;
  /** Replay guard for Stripe webhook deduplication. */
  replayGuard: IWebhookSeenRepository;
  /** Replay guard for BTCPay webhook deduplication. */
  cryptoReplayGuard: IWebhookSeenRepository;
  affiliateRepo: IAffiliateRepository;
  cryptoChargeRepo?: ICryptoChargeRepository;
}

const metadataMap = buildTokenMetadataMap();
const adminAuth = scopedBearerAuthWithTenant(metadataMap, "admin");

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

const cryptoWebhookBodySchema = z.object({
  deliveryId: z.string().min(1),
  webhookId: z.string().min(1),
  originalDeliveryId: z.string().min(1),
  isRedelivery: z.boolean(),
  type: z.string().min(1),
  timestamp: z.number(),
  storeId: z.string().min(1),
  invoiceId: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).default({}),
  manuallyMarked: z.boolean().optional(),
  overPaid: z.boolean().optional(),
  partiallyPaid: z.boolean().optional(),
});

// -- Route factory ------------------------------------------------------------

let _deps: BillingRouteDeps | null = null;

let cryptoClient: CryptoServiceClient | null = null;

/** Inject dependencies (call before serving). */
export function setBillingDeps(d: BillingRouteDeps): void {
  _deps = d;

  // Crypto initialization (optional — only if env vars are set)
  const cryptoConfig = loadCryptoConfig();
  if (cryptoConfig) {
    cryptoClient = new CryptoServiceClient(cryptoConfig);
  } else {
    cryptoClient = null;
  }
}

function getDeps(): BillingRouteDeps {
  if (!_deps) {
    throw new Error("Billing routes not initialized — call setBillingDeps() first");
  }
  return _deps;
}

// BOUNDARY(WOP-805): REST is the correct layer for billing routes.
// - /billing/webhook: Stripe signature verification (raw HTTP, not tRPC)
// - /billing/crypto/*: BTCPay webhook + checkout (external service signatures)
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
  const { processor } = getDeps();

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

  // ── Tenant ownership check (WOP-1419) ──
  const tokenTenantId = c.get("tokenTenantId");
  if (tokenTenantId && tenant !== tokenTenantId) {
    return c.json({ error: "Forbidden" }, 403);
  }

  try {
    assertSafeRedirectUrl(successUrl);
    assertSafeRedirectUrl(cancelUrl);
  } catch {
    return c.json({ error: "Invalid redirect URL" }, 400);
  }

  try {
    // StripePaymentProcessor resolves the priceId to the matching credit tier internally.
    const session = await processor.createCheckoutSession({
      tenant,
      successUrl,
      cancelUrl,
      priceId,
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
  const { processor } = getDeps();

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

  // ── Tenant ownership check (WOP-1419) ──
  const tokenTenantId = c.get("tokenTenantId");
  if (tokenTenantId && tenant !== tokenTenantId) {
    return c.json({ error: "Forbidden" }, 403);
  }

  try {
    assertSafeRedirectUrl(returnUrl);
  } catch {
    return c.json({ error: "Invalid redirect URL" }, 400);
  }

  // Intentional 501: not all payment processors support a self-service portal (e.g. PayRam).
  // Clients should check for this error code and hide the "Manage Billing" button.
  if (!processor.supportsPortal()) {
    return c.json(
      {
        error: "billing_portal_not_supported",
        message: "Customer billing portal is not available for the current payment processor",
      },
      501,
    );
  }

  try {
    const session = await processor.createPortalSession({ tenant, returnUrl });
    if (!session?.url) {
      return c.json(
        {
          error: "billing_portal_not_supported",
          message: "Customer billing portal is not available for the current payment processor",
        },
        501,
      );
    }
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
  const { processor } = getDeps();

  const tokenTenantId = c.get("tokenTenantId");
  if (!tokenTenantId) {
    return c.json({ error: "Missing tenant" }, 400);
  }

  const parsedTenant = tenantIdSchema.safeParse(tokenTenantId);
  if (!parsedTenant.success) {
    return c.json({ error: "Invalid tenant" }, 400);
  }

  try {
    const result = await processor.setupPaymentMethod(parsedTenant.data);
    if (!result.clientSecret) {
      return c.json({ error: "Failed to create setup intent" }, 500);
    }
    return c.json({ clientSecret: result.clientSecret });
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
  const { processor } = getDeps();

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
    await processor.detachPaymentMethod(parsedTenant.data, parsedId.data.id);
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
  const { processor, sigPenaltyRepo } = getDeps();
  const ip = getClientIpFromContext(c);
  const now = Date.now();

  // Check if this IP is currently in penalty backoff
  const penalty = await sigPenaltyRepo.get(ip, "stripe");
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

  try {
    const result = await processor.handleWebhook(Buffer.from(body), signature);
    // Clear any stale penalties on successful verification (WOP-477)
    await sigPenaltyRepo.clear(ip, "stripe");

    if (result.duplicate) {
      logger.warn("Webhook replay attempt detected", {
        eventType: result.eventType,
        ip,
      });
    }

    const { eventType, ...rest } = result;
    return c.json({ ...rest, event_type: eventType }, 200);
  } catch (err) {
    // Track signature failure for exponential backoff (WOP-477)
    const updated = await sigPenaltyRepo.recordFailure(ip, "stripe");

    logger.error("Webhook signature verification failed", {
      error: err instanceof Error ? err.message : String(err),
      ip,
      consecutiveFailures: updated.failures,
    });
    return c.json({ error: "Invalid webhook signature" }, 400);
  }
});

/**
 * POST /billing/crypto/checkout
 *
 * Create a BTCPay payment session for a one-time crypto credit purchase.
 * Body: { tenant, amountUsd }
 */
billingRoutes.post("/crypto/checkout", adminAuth, async (c) => {
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

  // ── Tenant ownership check (WOP-1419) ──
  const tokenTenantId = c.get("tokenTenantId");
  if (tokenTenantId && parsed.data.tenant !== tokenTenantId) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const { cryptoChargeRepo: chargeStore } = getDeps();
  if (!cryptoClient || !chargeStore) {
    return c.json({ error: "Crypto payments not configured" }, 503);
  }

  try {
    const { tenant, amountUsd } = parsed.data;
    if (amountUsd < MIN_PAYMENT_USD) {
      return c.json({ error: `Minimum payment amount is $${MIN_PAYMENT_USD}` }, 400);
    }
    const charge = await cryptoClient.createCharge({ chain: "btc", amountUsd });
    const amountUsdCents = Credit.fromDollars(amountUsd).toCentsRounded();
    await chargeStore.create(charge.chargeId, tenant, amountUsdCents);
    return c.json({ referenceId: charge.chargeId, address: charge.address, chain: charge.chain });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Crypto checkout failed";
    return c.json({ error: message }, 500);
  }
});

/**
 * POST /billing/crypto/webhook
 *
 * BTCPay Server webhook endpoint. Verifies HMAC-SHA256 signature via BTCPAY-SIG header.
 * Also supports IP allowlisting and sig-penalty exponential backoff.
 * Note: No bearer auth — webhook uses BTCPay signature verification.
 */
billingRoutes.post("/crypto/webhook", async (c) => {
  const { sigPenaltyRepo, creditLedger, cryptoChargeRepo: chargeStore, cryptoReplayGuard } = getDeps();
  if (!chargeStore) {
    return c.json({ error: "Crypto payments not configured" }, 503);
  }

  const ip = getClientIpFromContext(c);
  const now = Date.now();

  // ── Sig-penalty backoff (mirrors Stripe handler, WOP-477) ──
  const penalty = await sigPenaltyRepo.get(ip, "crypto");
  if (penalty && now < penalty.blockedUntil) {
    const retryAfterSec = Math.ceil((penalty.blockedUntil - now) / 1000);
    c.header("Retry-After", String(retryAfterSec));
    return c.json({ error: "Too many failed webhook signature attempts" }, 429);
  }

  // ── IP allowlist (optional) ──
  const allowedIps = process.env.BTCPAY_WEBHOOK_ALLOWED_IPS;
  if (allowedIps) {
    const allowed = allowedIps
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (allowed.length === 0) {
      logger.error("BTCPay webhook rejected: BTCPAY_WEBHOOK_ALLOWED_IPS is set but contains no valid entries");
      return c.json({ error: "Forbidden" }, 403);
    }
    const normalizedIp = ip.replace(/^::ffff:/, "");
    if (!allowed.includes(normalizedIp)) {
      logger.error("BTCPay webhook rejected: IP not in allowlist", { ip });
      return c.json({ error: "Forbidden" }, 403);
    }
  }

  // ── Read raw body (must happen before JSON parse) ──
  const rawBody = await c.req.text();

  // ── Authentication: HMAC-SHA256 via BTCPAY-SIG header ──
  const webhookSecret = process.env.BTCPAY_WEBHOOK_SECRET;
  if (!webhookSecret) {
    return c.json({ error: "BTCPay webhook secret not configured" }, 503);
  }

  const sigHeader = c.req.header("BTCPAY-SIG");
  const authenticated = verifyCryptoWebhookSignature(rawBody, sigHeader, webhookSecret);

  if (!authenticated) {
    try {
      await sigPenaltyRepo.recordFailure(ip, "crypto");
    } catch (err) {
      logger.warn("Failed to record sig penalty", { ip, err });
    }
    logger.error("BTCPay webhook signature verification failed", { ip });
    return c.json({ error: "Unauthorized" }, 401);
  }

  // Clear stale penalties on successful auth
  try {
    await sigPenaltyRepo.clear(ip, "crypto");
  } catch (err) {
    logger.warn("Failed to clear sig penalty", { ip, err });
  }

  // ── Parse and validate payload ──
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return c.json({ received: false }, 400);
  }

  const parsed = cryptoWebhookBodySchema.safeParse(body);
  if (!parsed.success) {
    logger.error("BTCPay webhook payload validation failed", {
      errors: parsed.error.flatten().fieldErrors,
    });
    return c.json({ received: false }, 400);
  }

  const result = await handleCryptoWebhook(
    {
      chargeStore,
      creditLedger,
      replayGuard: cryptoReplayGuard,
    },
    parsed.data,
  );

  if (result.duplicate) {
    logger.warn("BTCPay webhook replay attempt detected", {
      invoiceId: parsed.data.invoiceId,
      type: parsed.data.type,
    });
  }

  // Transport-level ACK is always affirmative once auth + payload validation pass.
  // Include handling state separately so callers can distinguish business outcomes.
  return c.json({ received: true, handled: result.handled }, 200);
});

/**
 * GET /billing/usage
 *
 * Query current period usage by capability/provider for a tenant.
 * Query params: tenant (required), capability, provider, startDate, endDate, limit
 */
billingRoutes.get("/usage", adminAuth, async (c) => {
  const aggregator = getDeps().meterAggregator;

  const requestedTenant = c.req.query("tenant");
  const tokenTenantId = c.get("tokenTenantId");
  const isOperator = c.get("isOperatorToken");

  if (tokenTenantId) {
    // Tenant-scoped token: must match the requested tenant
    if (requestedTenant && requestedTenant !== tokenTenantId) {
      return c.json({ error: "Forbidden" }, 403);
    }
  } else if (isOperator) {
    // Operator token: allowed to query any tenant, audit log emitted after validation below
  } else {
    // Token has no tenant scope and is not an operator — reject
    return c.json({ error: "Forbidden" }, 403);
  }

  const params = {
    tenant: tokenTenantId ?? c.req.query("tenant"),
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

  if (isOperator && parsed.data.tenant) {
    const authHeader = c.req.header("Authorization") ?? "";
    const tokenHint = authHeader.startsWith("Bearer ") ? `${authHeader.slice(7, 15)}***` : "***";
    try {
      logger.info("Operator cross-tenant access", {
        endpoint: "GET /billing/usage",
        tenant: parsed.data.tenant,
        operatorTokenHint: tokenHint,
      });
    } catch {
      // audit log failure must not mask primary operation
    }
  }

  const { tenant, startDate, endDate, limit } = parsed.data;

  try {
    const summaries = await aggregator.querySummaries(tenant, {
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
  const aggregator = getDeps().meterAggregator;

  const requestedTenant = c.req.query("tenant");
  const tokenTenantId = c.get("tokenTenantId");
  const isOperator = c.get("isOperatorToken");

  if (tokenTenantId) {
    if (requestedTenant && requestedTenant !== tokenTenantId) {
      return c.json({ error: "Forbidden" }, 403);
    }
  } else if (isOperator) {
    // Operator token: allowed to query any tenant, audit log emitted after validation below
  } else {
    return c.json({ error: "Forbidden" }, 403);
  }

  const params = {
    tenant: tokenTenantId ?? c.req.query("tenant"),
    startDate: c.req.query("startDate"),
  };

  const parsed = usageQuerySchema.safeParse(params);

  if (!parsed.success) {
    return c.json({ error: "Invalid query parameters", details: parsed.error.flatten().fieldErrors }, 400);
  }

  if (isOperator && parsed.data.tenant) {
    const authHeader = c.req.header("Authorization") ?? "";
    const tokenHint = authHeader.startsWith("Bearer ") ? `${authHeader.slice(7, 15)}***` : "***";
    try {
      logger.info("Operator cross-tenant access", {
        endpoint: "GET /billing/usage/summary",
        tenant: parsed.data.tenant,
        operatorTokenHint: tokenHint,
      });
    } catch {
      // audit log failure must not mask primary operation
    }
  }

  const { tenant, startDate } = parsed.data;

  try {
    // Default to start of current billing period (beginning of current hour)
    const since = startDate ?? Math.floor(Date.now() / 3_600_000) * 3_600_000;
    const total = await aggregator.getTenantTotal(tenant, since);

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
billingRoutes.get("/affiliate", adminAuth, async (c) => {
  const tokenTenantId = c.get("tokenTenantId");
  const isOperator = c.get("isOperatorToken");

  let tenant: string | undefined;
  if (tokenTenantId) {
    // Tenant-scoped token: always use the token's tenant (ignore query param)
    tenant = tokenTenantId;
  } else if (isOperator) {
    // Operator token: read from query param, validate and audit log below
    tenant = c.req.query("tenant");
  } else {
    // Token has no tenant scope and is not an operator — reject
    return c.json({ error: "Forbidden" }, 403);
  }

  if (!tenant) {
    return c.json({ error: "Missing tenant" }, 400);
  }

  const parsedTenant = tenantIdSchema.safeParse(tenant);
  if (!parsedTenant.success) {
    return c.json({ error: "Invalid tenant" }, 400);
  }

  if (isOperator) {
    const authHeader = c.req.header("Authorization") ?? "";
    const tokenHint = authHeader.startsWith("Bearer ") ? `${authHeader.slice(7, 15)}***` : "***";
    try {
      logger.info("Operator cross-tenant access", {
        endpoint: "GET /billing/affiliate",
        tenant: parsedTenant.data,
        operatorTokenHint: tokenHint,
      });
    } catch {
      // audit log failure must not mask primary operation
    }
  }

  try {
    const repo = getDeps().affiliateRepo;
    const stats = await repo.getStats(parsedTenant.data);
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
  const clientIp = getClientIpFromContext(c);

  try {
    const repo = getDeps().affiliateRepo;
    const codeRecord = await repo.getByCode(code);
    if (!codeRecord) {
      return c.json({ error: "Invalid referral code" }, 404);
    }

    const isNew = await repo.recordReferral(codeRecord.tenantId, referredTenantId, code, {
      signupIp: clientIp !== "unknown" ? clientIp : undefined,
    });
    return c.json({ recorded: isNew, referrer: codeRecord.tenantId });
  } catch (err) {
    if (err instanceof Error && err.message.includes("Self-referral")) {
      return c.json({ error: "Self-referral is not allowed" }, 400);
    }
    const message = err instanceof Error ? err.message : "Failed to record referral";
    return c.json({ error: message }, 500);
  }
});
