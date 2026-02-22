/**
 * tRPC TENANT ISOLATION TESTS — WOP-822
 *
 * Verifies that a tenant-scoped caller cannot access another tenant's data
 * via the tRPC billing, capabilities, and settings routers.
 *
 * Pattern: create two callers with different tenantId values, attempt cross-tenant
 * access, and assert that FORBIDDEN is thrown.
 *
 * Key finding:
 * - billing.usage, usageSummary, usageHistory: HAVE isolation check (pass)
 * - billing.creditsBalance, creditsHistory, creditsCheckout, portalSession:
 *   HAVE isolation check (pass) — check is `input.tenant && input.tenant !== (ctx.tenantId ?? ctx.user.id)`
 * - capabilities.*: use tenantProcedure — ctx.tenantId only, never user input → safe
 * - settings.*: use tenantProcedure — ctx.tenantId only, never user input → safe
 */

import BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CreditAdjustmentStore } from "../../src/admin/credits/adjustment-store.js";
import { initCreditAdjustmentSchema } from "../../src/admin/credits/schema.js";
import { createDb, type DrizzleDb } from "../../src/db/index.js";
import { initMeterSchema } from "../../src/monetization/metering/schema.js";
import { initStripeSchema } from "../../src/monetization/stripe/schema.js";
import { TenantKeyStore } from "../../src/security/tenant-keys/schema.js";
import { appRouter } from "../../src/trpc/index.js";
import type { TRPCContext } from "../../src/trpc/init.js";
import { setBillingRouterDeps } from "../../src/trpc/routers/billing.js";
import { setCapabilitiesRouterDeps } from "../../src/trpc/routers/capabilities.js";
import { setSettingsRouterDeps } from "../../src/trpc/routers/settings.js";

// ---------------------------------------------------------------------------
// Two test tenants
// ---------------------------------------------------------------------------

const TENANT_A = "tenant-alpha";
const TENANT_B = "tenant-bravo";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ctxForTenant(tenantId: string): TRPCContext {
  return {
    user: { id: `user-${tenantId}`, roles: ["user"] },
    tenantId,
  };
}

function createTestDb() {
  const sqlite = new BetterSqlite3(":memory:");
  sqlite.pragma("journal_mode = WAL");
  initMeterSchema(sqlite);
  initStripeSchema(sqlite);
  initCreditAdjustmentSchema(sqlite);
  const db = createDb(sqlite);
  return { sqlite, db };
}

// ---------------------------------------------------------------------------
// Describe blocks
// ---------------------------------------------------------------------------

describe("tRPC tenant isolation — billing router (WOP-822)", () => {
  let sqlite: BetterSqlite3.Database;
  let db: DrizzleDb;

  beforeEach(async () => {
    ({ sqlite, db } = createTestDb());

    const creditStore = new CreditAdjustmentStore(sqlite);
    const { MeterAggregator } = await import("../../src/monetization/metering/aggregator.js");
    const meterAggregator = new MeterAggregator(db);
    const { TenantCustomerStore } = await import("../../src/monetization/stripe/tenant-store.js");
    const tenantStore = new TenantCustomerStore(db);
    const { StripeUsageReporter } = await import("../../src/monetization/stripe/usage-reporter.js");
    const mockStripe = { billing: { meterEvents: { create: () => Promise.resolve() } } };
    const usageReporter = new StripeUsageReporter(db, mockStripe as never, tenantStore);

    setBillingRouterDeps({
      stripe: {
        checkout: { sessions: { create: () => Promise.resolve({ id: "cs_test", url: "https://checkout.stripe.com/test" }) } },
        billingPortal: { sessions: { create: () => Promise.resolve({ url: "https://billing.stripe.com/test" }) } },
      } as never,
      tenantStore,
      creditStore,
      meterAggregator,
      usageReporter,
      priceMap: undefined,
      dividendRepo: {
        getStats: () => ({ poolCents: 0, activeUsers: 0, perUserCents: 0, nextDistributionAt: new Date().toISOString(), userEligible: false, userLastPurchaseAt: null, userWindowExpiresAt: null }),
        getHistory: () => [],
        getLifetimeTotalCents: () => 0,
      },
    });
  });

  afterEach(() => {
    sqlite.close();
  });

  // -------------------------------------------------------------------------
  // creditsBalance — has isolation check
  // -------------------------------------------------------------------------

  it("tenant-scoped caller cannot read other tenant's creditsBalance", async () => {
    const callerA = appRouter.createCaller(ctxForTenant(TENANT_A));

    // Caller with tenantId=TENANT_A passes tenant=TENANT_B — should be FORBIDDEN
    await expect(callerA.billing.creditsBalance({ tenant: TENANT_B })).rejects.toThrow("Access denied");
  });

  it("tenant-scoped caller can read own creditsBalance", async () => {
    const callerA = appRouter.createCaller(ctxForTenant(TENANT_A));
    const result = await callerA.billing.creditsBalance({ tenant: TENANT_A });
    expect(result.tenant).toBe(TENANT_A);
    expect(result.balance_cents).toBe(0);
  });

  it("tenant-scoped caller can omit tenant and get own creditsBalance via ctx", async () => {
    const callerA = appRouter.createCaller(ctxForTenant(TENANT_A));
    const result = await callerA.billing.creditsBalance({});
    expect(result.tenant).toBe(TENANT_A);
  });

  // -------------------------------------------------------------------------
  // creditsHistory — has isolation check
  // -------------------------------------------------------------------------

  it("tenant-scoped caller cannot read other tenant's creditsHistory", async () => {
    const callerA = appRouter.createCaller(ctxForTenant(TENANT_A));

    await expect(callerA.billing.creditsHistory({ tenant: TENANT_B })).rejects.toThrow("Access denied");
  });

  it("tenant-scoped caller can read own creditsHistory", async () => {
    const callerA = appRouter.createCaller(ctxForTenant(TENANT_A));
    const result = await callerA.billing.creditsHistory({ tenant: TENANT_A });
    expect(result.entries).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // creditsCheckout — has isolation check
  // -------------------------------------------------------------------------

  it("tenant-scoped caller cannot create checkout for other tenant", async () => {
    const callerA = appRouter.createCaller(ctxForTenant(TENANT_A));

    await expect(
      callerA.billing.creditsCheckout({
        tenant: TENANT_B,
        priceId: "price_test123",
        successUrl: "https://example.com/success",
        cancelUrl: "https://example.com/cancel",
      }),
    ).rejects.toThrow("Access denied");
  });

  // -------------------------------------------------------------------------
  // portalSession — has isolation check
  // -------------------------------------------------------------------------

  it("tenant-scoped caller cannot open portal session for other tenant", async () => {
    const callerA = appRouter.createCaller(ctxForTenant(TENANT_A));

    await expect(
      callerA.billing.portalSession({
        tenant: TENANT_B,
        returnUrl: "https://example.com/billing",
      }),
    ).rejects.toThrow("Access denied");
  });

  // -------------------------------------------------------------------------
  // usage — has isolation check (verifies existing protection)
  // -------------------------------------------------------------------------

  it("tenant-scoped caller cannot read other tenant's usage (existing protection)", async () => {
    const callerA = appRouter.createCaller(ctxForTenant(TENANT_A));

    await expect(callerA.billing.usage({ tenant: TENANT_B })).rejects.toThrow("Forbidden");
  });

  it("tenant-scoped caller can read own usage", async () => {
    const callerA = appRouter.createCaller(ctxForTenant(TENANT_A));
    const result = await callerA.billing.usage({ tenant: TENANT_A });
    expect(result.tenant).toBe(TENANT_A);
    expect(result.usage).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // usageSummary — has isolation check (verifies existing protection)
  // -------------------------------------------------------------------------

  it("tenant-scoped caller cannot read other tenant's usageSummary (existing protection)", async () => {
    const callerA = appRouter.createCaller(ctxForTenant(TENANT_A));

    await expect(callerA.billing.usageSummary({ tenant: TENANT_B })).rejects.toThrow("Forbidden");
  });

  // -------------------------------------------------------------------------
  // usageHistory — has isolation check (verifies existing protection)
  // -------------------------------------------------------------------------

  it("tenant-scoped caller cannot read other tenant's usageHistory (existing protection)", async () => {
    const callerA = appRouter.createCaller(ctxForTenant(TENANT_A));

    await expect(callerA.billing.usageHistory({ tenant: TENANT_B })).rejects.toThrow("Forbidden");
  });

  it("tenant-scoped caller can read own usageHistory", async () => {
    const callerA = appRouter.createCaller(ctxForTenant(TENANT_A));
    const result = await callerA.billing.usageHistory({ tenant: TENANT_A });
    expect(result.tenant).toBe(TENANT_A);
    expect(result.reports).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Capabilities router — uses tenantProcedure (ctx.tenantId only)
// ---------------------------------------------------------------------------

describe("tRPC tenant isolation — capabilities router (WOP-822)", () => {
  let sqlite: BetterSqlite3.Database;
  let store: TenantKeyStore;

  beforeEach(() => {
    sqlite = new BetterSqlite3(":memory:");
    store = new TenantKeyStore(sqlite);

    setCapabilitiesRouterDeps({
      getTenantKeyStore: () => store,
      encrypt: (plaintext: string) => ({ ciphertext: `enc:${plaintext}`, iv: "test-iv" }),
      deriveTenantKey: (_tenantId: string, _secret: string) => Buffer.alloc(32),
      platformSecret: "test-platform-secret-32bytes!!ok",
    });
  });

  afterEach(() => {
    sqlite.close();
  });

  it("listKeys returns only caller's own tenant keys", async () => {
    // Store a key directly for TENANT_B
    store.upsert(TENANT_B, "openai", { ciphertext: "enc:sk-b", iv: "iv" }, "B Key");

    // Caller for TENANT_A should see empty list
    const callerA = appRouter.createCaller(ctxForTenant(TENANT_A));
    const result = await callerA.capabilities.listKeys();
    expect(result.keys).toHaveLength(0);

    // Caller for TENANT_B should see their key
    const callerB = appRouter.createCaller(ctxForTenant(TENANT_B));
    const resultB = await callerB.capabilities.listKeys();
    expect(resultB.keys).toHaveLength(1);
  });

  it("getKey returns NOT_FOUND for other tenant's key", async () => {
    // Store a key for TENANT_B
    store.upsert(TENANT_B, "anthropic", { ciphertext: "enc:sk-b", iv: "iv" }, "B Anthropic");

    // TENANT_A caller tries to get TENANT_B's key
    const callerA = appRouter.createCaller(ctxForTenant(TENANT_A));
    await expect(callerA.capabilities.getKey({ provider: "anthropic" })).rejects.toThrow("No key stored");
  });

  it("storeKey stores under caller's tenantId only", async () => {
    const callerA = appRouter.createCaller(ctxForTenant(TENANT_A));
    await callerA.capabilities.storeKey({ provider: "openai", apiKey: "sk-alpha-key", label: "A Key" });

    // Key should exist for TENANT_A
    const recordA = store.get(TENANT_A, "openai");
    expect(recordA).toBeDefined();

    // Key should NOT exist for TENANT_B
    const recordB = store.get(TENANT_B, "openai");
    expect(recordB).toBeUndefined();
  });

  it("deleteKey cannot delete other tenant's key", async () => {
    // Store a key for TENANT_B
    store.upsert(TENANT_B, "anthropic", { ciphertext: "enc:sk-b", iv: "iv" }, "B Key");

    // TENANT_A caller tries to delete it — should get NOT_FOUND (not B's key)
    const callerA = appRouter.createCaller(ctxForTenant(TENANT_A));
    await expect(callerA.capabilities.deleteKey({ provider: "anthropic" })).rejects.toThrow("No key stored");

    // B's key should still be intact
    const record = store.get(TENANT_B, "anthropic");
    expect(record).toBeDefined();
  });

  it("each tenant's keys are stored independently across concurrent operations", async () => {
    const callerA = appRouter.createCaller(ctxForTenant(TENANT_A));
    const callerB = appRouter.createCaller(ctxForTenant(TENANT_B));

    // Both store a key for the same provider
    await callerA.capabilities.storeKey({ provider: "openai", apiKey: "sk-alpha", label: "A" });
    await callerB.capabilities.storeKey({ provider: "openai", apiKey: "sk-bravo", label: "B" });

    // Each sees only their own
    const resultA = await callerA.capabilities.listKeys();
    const resultB = await callerB.capabilities.listKeys();

    expect(resultA.keys).toHaveLength(1);
    expect(resultB.keys).toHaveLength(1);
    // Labels must not cross tenants
    expect((resultA.keys[0] as { label: string }).label).toBe("A");
    expect((resultB.keys[0] as { label: string }).label).toBe("B");
  });
});

// ---------------------------------------------------------------------------
// Settings router — uses tenantProcedure (ctx.tenantId only)
// ---------------------------------------------------------------------------

describe("tRPC tenant isolation — settings router (WOP-822)", () => {
  beforeEach(async () => {
    const { NotificationPreferencesStore } = await import(
      "../../src/email/notification-preferences-store.js"
    );
    const sqlite = new BetterSqlite3(":memory:");
    sqlite.exec(`
      CREATE TABLE notification_preferences (
        tenant_id TEXT PRIMARY KEY,
        billing_low_balance INTEGER NOT NULL DEFAULT 1,
        billing_receipts INTEGER NOT NULL DEFAULT 1,
        billing_auto_topup INTEGER NOT NULL DEFAULT 1,
        agent_channel_disconnect INTEGER NOT NULL DEFAULT 1,
        agent_status_changes INTEGER NOT NULL DEFAULT 0,
        account_role_changes INTEGER NOT NULL DEFAULT 1,
        account_team_invites INTEGER NOT NULL DEFAULT 1,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      )
    `);
    const db = createDb(sqlite);
    const notifStore = new NotificationPreferencesStore(db);

    setSettingsRouterDeps({ getNotificationPrefsStore: () => notifStore });
  });

  it("tenantConfig returns caller's own tenantId", async () => {
    const callerA = appRouter.createCaller(ctxForTenant(TENANT_A));
    const result = await callerA.settings.tenantConfig();
    expect(result.tenantId).toBe(TENANT_A);
  });

  it("tenantConfig for tenant B returns tenant B's id", async () => {
    const callerB = appRouter.createCaller(ctxForTenant(TENANT_B));
    const result = await callerB.settings.tenantConfig();
    expect(result.tenantId).toBe(TENANT_B);
  });

  it("ping returns caller's tenantId", async () => {
    const callerA = appRouter.createCaller(ctxForTenant(TENANT_A));
    const result = await callerA.settings.ping();
    expect(result.tenantId).toBe(TENANT_A);
    expect(result.ok).toBe(true);
  });

  it("notificationPreferences are scoped to caller's tenant", async () => {
    const callerA = appRouter.createCaller(ctxForTenant(TENANT_A));
    const callerB = appRouter.createCaller(ctxForTenant(TENANT_B));

    // Update prefs for A — disable billing_low_balance (default is true)
    await callerA.settings.updateNotificationPreferences({ billing_low_balance: false });

    // A sees their updated prefs
    const prefsA = await callerA.settings.notificationPreferences();
    expect(prefsA.billing_low_balance).toBe(false);

    // B sees their own default prefs — A's change must NOT bleed into B
    const prefsB = await callerB.settings.notificationPreferences();
    expect(prefsB.billing_low_balance).toBe(true); // B still has default true
  });

  it("tenantProcedure rejects caller with no tenantId", async () => {
    const caller = appRouter.createCaller({ user: { id: "u1", roles: ["user"] }, tenantId: undefined });
    await expect(caller.settings.ping()).rejects.toThrow("Tenant context required");
  });
});
