/**
 * Unit tests for PayRam webhook handler (WOP-407).
 *
 * Covers FILLED/OVER_FILLED crediting the ledger, PARTIALLY_FILLED/CANCELLED
 * no-op status, idempotency, replay guard, and bot reactivation.
 */

import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../../test/db.js";
import { CreditLedger } from "../credits/credit-ledger.js";
import { DrizzleWebhookSeenRepository } from "../drizzle-webhook-seen-repository.js";
import { PayRamChargeStore } from "./charge-store.js";
import type { PayRamWebhookDeps, PayRamWebhookPayload } from "./index.js";
import { handlePayRamWebhook } from "./webhook.js";

async function makeReplayGuard() {
  const { db } = await createTestDb();
  return new DrizzleWebhookSeenRepository(db);
}

function makePayload(overrides: Partial<PayRamWebhookPayload> = {}): PayRamWebhookPayload {
  return {
    reference_id: "ref-test-001",
    status: "FILLED",
    amount: "25.00",
    currency: "USDC",
    filled_amount: "25.00",
    ...overrides,
  };
}

describe("handlePayRamWebhook", () => {
  let chargeStore: PayRamChargeStore;
  let creditLedger: CreditLedger;
  let deps: PayRamWebhookDeps;
  let pool: PGlite;

  beforeEach(async () => {
    const { db, pool: p } = await createTestDb();
    pool = p;
    chargeStore = new PayRamChargeStore(db);
    creditLedger = new CreditLedger(db);
    deps = { chargeStore, creditLedger };

    // Create a default test charge
    await chargeStore.create("ref-test-001", "tenant-a", 2500);
  });

  afterEach(async () => {
    await pool.close();
  });

  // ---------------------------------------------------------------------------
  // FILLED / OVER_FILLED — should credit ledger
  // ---------------------------------------------------------------------------

  describe("FILLED status", () => {
    it("credits the ledger with the requested USD amount", async () => {
      const result = await handlePayRamWebhook(deps, makePayload({ status: "FILLED" }));

      expect(result.handled).toBe(true);
      expect(result.status).toBe("FILLED");
      expect(result.tenant).toBe("tenant-a");
      expect(result.creditedCents).toBe(2500);

      const balance = await creditLedger.balance("tenant-a");
      expect(balance).toBe(2500);
    });

    it("uses payram: prefix on reference ID in credit transaction", async () => {
      await handlePayRamWebhook(deps, makePayload({ status: "FILLED" }));

      const history = await creditLedger.history("tenant-a");
      expect(history).toHaveLength(1);
      expect(history[0].referenceId).toBe("payram:ref-test-001");
      expect(history[0].type).toBe("purchase");
    });

    it("records fundingSource as payram", async () => {
      await handlePayRamWebhook(deps, makePayload({ status: "FILLED" }));

      const history = await creditLedger.history("tenant-a");
      expect(history[0].fundingSource).toBe("payram");
    });

    it("marks the charge as credited after FILLED", async () => {
      await handlePayRamWebhook(deps, makePayload({ status: "FILLED" }));
      expect(await chargeStore.isCredited("ref-test-001")).toBe(true);
    });

    it("is idempotent — duplicate FILLED webhook does not double-credit", async () => {
      await handlePayRamWebhook(deps, makePayload({ status: "FILLED" }));
      const result2 = await handlePayRamWebhook(deps, makePayload({ status: "FILLED" }));

      expect(result2.handled).toBe(true);
      expect(result2.creditedCents).toBe(0);

      const balance = await creditLedger.balance("tenant-a");
      expect(balance).toBe(2500); // Only credited once
    });
  });

  describe("OVER_FILLED status", () => {
    it("credits the requested USD amount (not the overpayment)", async () => {
      await chargeStore.create("ref-over-001", "tenant-b", 1000);

      const result = await handlePayRamWebhook(
        deps,
        makePayload({
          reference_id: "ref-over-001",
          status: "OVER_FILLED",
          filled_amount: "12.50", // Overpaid by $2.50
          currency: "ETH",
        }),
      );

      expect(result.handled).toBe(true);
      expect(result.creditedCents).toBe(1000); // Only the requested amount
      expect(await creditLedger.balance("tenant-b")).toBe(1000);
    });
  });

  // ---------------------------------------------------------------------------
  // Statuses that should NOT credit the ledger
  // ---------------------------------------------------------------------------

  describe("PARTIALLY_FILLED status", () => {
    it("does NOT credit the ledger", async () => {
      const result = await handlePayRamWebhook(deps, makePayload({ status: "PARTIALLY_FILLED" }));

      expect(result.handled).toBe(true);
      expect(result.tenant).toBe("tenant-a");
      expect(result.creditedCents).toBeUndefined();
      expect(await creditLedger.balance("tenant-a")).toBe(0);
    });
  });

  describe("VERIFYING status", () => {
    it("does NOT credit the ledger", async () => {
      const result = await handlePayRamWebhook(deps, makePayload({ status: "VERIFYING" }));

      expect(result.handled).toBe(true);
      expect(result.creditedCents).toBeUndefined();
      expect(await creditLedger.balance("tenant-a")).toBe(0);
    });
  });

  describe("OPEN status", () => {
    it("does NOT credit the ledger", async () => {
      const result = await handlePayRamWebhook(deps, makePayload({ status: "OPEN" }));

      expect(result.handled).toBe(true);
      expect(result.creditedCents).toBeUndefined();
      expect(await creditLedger.balance("tenant-a")).toBe(0);
    });
  });

  describe("CANCELLED status", () => {
    it("does NOT credit the ledger", async () => {
      const result = await handlePayRamWebhook(deps, makePayload({ status: "CANCELLED" }));

      expect(result.handled).toBe(true);
      expect(result.creditedCents).toBeUndefined();
      expect(await creditLedger.balance("tenant-a")).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Unknown reference ID
  // ---------------------------------------------------------------------------

  describe("unknown reference_id", () => {
    it("returns handled:false when charge not found", async () => {
      const result = await handlePayRamWebhook(deps, makePayload({ reference_id: "ref-unknown-999" }));

      expect(result.handled).toBe(false);
      expect(result.tenant).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Charge store updates
  // ---------------------------------------------------------------------------

  describe("charge store updates", () => {
    it("updates charge status on every webhook call", async () => {
      await handlePayRamWebhook(deps, makePayload({ status: "VERIFYING" }));

      const charge = await chargeStore.getByReferenceId("ref-test-001");
      expect(charge?.status).toBe("VERIFYING");
    });

    it("updates currency and filled_amount on FILLED", async () => {
      await handlePayRamWebhook(deps, makePayload({ status: "FILLED", currency: "USDT", filled_amount: "25.00" }));

      const charge = await chargeStore.getByReferenceId("ref-test-001");
      expect(charge?.currency).toBe("USDT");
      expect(charge?.filledAmount).toBe("25.00");
    });
  });

  // ---------------------------------------------------------------------------
  // Multiple tenants / reference IDs
  // ---------------------------------------------------------------------------

  describe("different reference IDs", () => {
    it("processes multiple reference IDs independently", async () => {
      await chargeStore.create("ref-b-001", "tenant-b", 5000);
      await chargeStore.create("ref-c-001", "tenant-c", 1500);

      await handlePayRamWebhook(deps, makePayload({ reference_id: "ref-b-001", status: "FILLED" }));
      await handlePayRamWebhook(deps, makePayload({ reference_id: "ref-c-001", status: "FILLED" }));

      expect(await creditLedger.balance("tenant-b")).toBe(5000);
      expect(await creditLedger.balance("tenant-c")).toBe(1500);
    });
  });

  // ---------------------------------------------------------------------------
  // Replay guard
  // ---------------------------------------------------------------------------

  describe("replay guard", () => {
    it("blocks duplicate reference_id + status combos", async () => {
      const replayGuard = await makeReplayGuard();
      const depsWithGuard: PayRamWebhookDeps = { ...deps, replayGuard };

      const first = await handlePayRamWebhook(depsWithGuard, makePayload({ status: "FILLED" }));
      expect(first.handled).toBe(true);
      expect(first.creditedCents).toBe(2500);
      expect(first.duplicate).toBeUndefined();

      const second = await handlePayRamWebhook(depsWithGuard, makePayload({ status: "FILLED" }));
      expect(second.handled).toBe(true);
      expect(second.duplicate).toBe(true);
      expect(second.creditedCents).toBeUndefined();

      // Only credited once
      expect(await creditLedger.balance("tenant-a")).toBe(2500);
    });

    it("same reference_id with different status is not blocked by replay guard", async () => {
      const replayGuard = await makeReplayGuard();
      const depsWithGuard: PayRamWebhookDeps = { ...deps, replayGuard };

      await handlePayRamWebhook(depsWithGuard, makePayload({ status: "VERIFYING" }));
      const result = await handlePayRamWebhook(depsWithGuard, makePayload({ status: "FILLED" }));

      expect(result.duplicate).toBeUndefined();
      expect(result.creditedCents).toBe(2500);
    });

    it("works without replay guard (backwards compatible)", async () => {
      const result = await handlePayRamWebhook(deps, makePayload({ status: "FILLED" }));
      expect(result.handled).toBe(true);
      expect(result.creditedCents).toBe(2500);
    });
  });

  // ---------------------------------------------------------------------------
  // Bot reactivation
  // ---------------------------------------------------------------------------

  describe("bot reactivation", () => {
    it("calls botBilling.checkReactivation on FILLED and includes reactivatedBots in result", async () => {
      const mockCheckReactivation = vi.fn().mockReturnValue(["bot-1", "bot-2"]);
      const depsWithBotBilling: PayRamWebhookDeps = {
        ...deps,
        botBilling: { checkReactivation: mockCheckReactivation } as unknown as Parameters<
          typeof handlePayRamWebhook
        >[0]["botBilling"],
      };

      const result = await handlePayRamWebhook(depsWithBotBilling, makePayload({ status: "FILLED" }));

      expect(mockCheckReactivation).toHaveBeenCalledWith("tenant-a", creditLedger);
      expect(result.reactivatedBots).toEqual(["bot-1", "bot-2"]);
    });

    it("does not include reactivatedBots when no bots reactivated", async () => {
      const mockCheckReactivation = vi.fn().mockReturnValue([]);
      const depsWithBotBilling: PayRamWebhookDeps = {
        ...deps,
        botBilling: { checkReactivation: mockCheckReactivation } as unknown as Parameters<
          typeof handlePayRamWebhook
        >[0]["botBilling"],
      };

      const result = await handlePayRamWebhook(depsWithBotBilling, makePayload({ status: "FILLED" }));

      expect(result.reactivatedBots).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// DrizzleWebhookSeenRepository unit tests (replaces PayRamReplayGuard)
// ---------------------------------------------------------------------------

describe("DrizzleWebhookSeenRepository (payram replay guard)", () => {
  it("reports unseen keys as not duplicate", async () => {
    const guard = await makeReplayGuard();
    expect(await guard.isDuplicate("ref-001:FILLED", "payram")).toBe(false);
  });

  it("reports seen keys as duplicate", async () => {
    const guard = await makeReplayGuard();
    await guard.markSeen("ref-001:FILLED", "payram");
    expect(await guard.isDuplicate("ref-001:FILLED", "payram")).toBe(true);
  });

  it("purges expired entries via purgeExpired", async () => {
    const guard = await makeReplayGuard();
    await guard.markSeen("ref-expire:FILLED", "payram");
    expect(await guard.isDuplicate("ref-expire:FILLED", "payram")).toBe(true);
    // Negative TTL pushes cutoff into the future — entry is expired
    await guard.purgeExpired(-24 * 60 * 60 * 1000);
    expect(await guard.isDuplicate("ref-expire:FILLED", "payram")).toBe(false);
  });
});
