/**
 * Unit tests for PayRam webhook handler (WOP-407).
 *
 * Covers FILLED/OVER_FILLED crediting the ledger, PARTIALLY_FILLED/CANCELLED
 * no-op status, idempotency, replay guard, and bot reactivation.
 */
import BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb } from "../../db/index.js";
import { CreditLedger } from "../credits/credit-ledger.js";
import { initCreditSchema } from "../credits/schema.js";
import { PayRamChargeStore } from "./charge-store.js";
import { initPayRamSchema } from "./schema.js";
import type { PayRamWebhookDeps, PayRamWebhookPayload } from "./index.js";
import { handlePayRamWebhook, PayRamReplayGuard } from "./webhook.js";

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
  let sqlite: BetterSqlite3.Database;
  let chargeStore: PayRamChargeStore;
  let creditLedger: CreditLedger;
  let deps: PayRamWebhookDeps;

  beforeEach(() => {
    sqlite = new BetterSqlite3(":memory:");
    initPayRamSchema(sqlite);
    initCreditSchema(sqlite);
    const db = createDb(sqlite);
    chargeStore = new PayRamChargeStore(db);
    creditLedger = new CreditLedger(db);
    deps = { chargeStore, creditLedger };

    // Create a default test charge
    chargeStore.create("ref-test-001", "tenant-a", 2500);
  });

  afterEach(() => {
    sqlite.close();
  });

  // ---------------------------------------------------------------------------
  // FILLED / OVER_FILLED — should credit ledger
  // ---------------------------------------------------------------------------

  describe("FILLED status", () => {
    it("credits the ledger with the requested USD amount", () => {
      const result = handlePayRamWebhook(deps, makePayload({ status: "FILLED" }));

      expect(result.handled).toBe(true);
      expect(result.status).toBe("FILLED");
      expect(result.tenant).toBe("tenant-a");
      expect(result.creditedCents).toBe(2500);

      const balance = creditLedger.balance("tenant-a");
      expect(balance).toBe(2500);
    });

    it("uses payram: prefix on reference ID in credit transaction", () => {
      handlePayRamWebhook(deps, makePayload({ status: "FILLED" }));

      const history = creditLedger.history("tenant-a");
      expect(history).toHaveLength(1);
      expect(history[0].referenceId).toBe("payram:ref-test-001");
      expect(history[0].type).toBe("purchase");
    });

    it("records fundingSource as payram", () => {
      handlePayRamWebhook(deps, makePayload({ status: "FILLED" }));

      const history = creditLedger.history("tenant-a");
      expect(history[0].fundingSource).toBe("payram");
    });

    it("marks the charge as credited after FILLED", () => {
      handlePayRamWebhook(deps, makePayload({ status: "FILLED" }));
      expect(chargeStore.isCredited("ref-test-001")).toBe(true);
    });

    it("is idempotent — duplicate FILLED webhook does not double-credit", () => {
      handlePayRamWebhook(deps, makePayload({ status: "FILLED" }));
      const result2 = handlePayRamWebhook(deps, makePayload({ status: "FILLED" }));

      expect(result2.handled).toBe(true);
      expect(result2.creditedCents).toBe(0);

      const balance = creditLedger.balance("tenant-a");
      expect(balance).toBe(2500); // Only credited once
    });
  });

  describe("OVER_FILLED status", () => {
    it("credits the requested USD amount (not the overpayment)", () => {
      chargeStore.create("ref-over-001", "tenant-b", 1000);

      const result = handlePayRamWebhook(deps, makePayload({
        reference_id: "ref-over-001",
        status: "OVER_FILLED",
        filled_amount: "12.50", // Overpaid by $2.50
        currency: "ETH",
      }));

      expect(result.handled).toBe(true);
      expect(result.creditedCents).toBe(1000); // Only the requested amount
      expect(creditLedger.balance("tenant-b")).toBe(1000);
    });
  });

  // ---------------------------------------------------------------------------
  // Statuses that should NOT credit the ledger
  // ---------------------------------------------------------------------------

  describe("PARTIALLY_FILLED status", () => {
    it("does NOT credit the ledger", () => {
      const result = handlePayRamWebhook(deps, makePayload({ status: "PARTIALLY_FILLED" }));

      expect(result.handled).toBe(true);
      expect(result.tenant).toBe("tenant-a");
      expect(result.creditedCents).toBeUndefined();
      expect(creditLedger.balance("tenant-a")).toBe(0);
    });
  });

  describe("VERIFYING status", () => {
    it("does NOT credit the ledger", () => {
      const result = handlePayRamWebhook(deps, makePayload({ status: "VERIFYING" }));

      expect(result.handled).toBe(true);
      expect(result.creditedCents).toBeUndefined();
      expect(creditLedger.balance("tenant-a")).toBe(0);
    });
  });

  describe("OPEN status", () => {
    it("does NOT credit the ledger", () => {
      const result = handlePayRamWebhook(deps, makePayload({ status: "OPEN" }));

      expect(result.handled).toBe(true);
      expect(result.creditedCents).toBeUndefined();
      expect(creditLedger.balance("tenant-a")).toBe(0);
    });
  });

  describe("CANCELLED status", () => {
    it("does NOT credit the ledger", () => {
      const result = handlePayRamWebhook(deps, makePayload({ status: "CANCELLED" }));

      expect(result.handled).toBe(true);
      expect(result.creditedCents).toBeUndefined();
      expect(creditLedger.balance("tenant-a")).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Unknown reference ID
  // ---------------------------------------------------------------------------

  describe("unknown reference_id", () => {
    it("returns handled:false when charge not found", () => {
      const result = handlePayRamWebhook(deps, makePayload({ reference_id: "ref-unknown-999" }));

      expect(result.handled).toBe(false);
      expect(result.tenant).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Charge store updates
  // ---------------------------------------------------------------------------

  describe("charge store updates", () => {
    it("updates charge status on every webhook call", () => {
      handlePayRamWebhook(deps, makePayload({ status: "VERIFYING" }));

      const charge = chargeStore.getByReferenceId("ref-test-001");
      expect(charge?.status).toBe("VERIFYING");
    });

    it("updates currency and filled_amount on FILLED", () => {
      handlePayRamWebhook(deps, makePayload({ status: "FILLED", currency: "USDT", filled_amount: "25.00" }));

      const charge = chargeStore.getByReferenceId("ref-test-001");
      expect(charge?.currency).toBe("USDT");
      expect(charge?.filledAmount).toBe("25.00");
    });
  });

  // ---------------------------------------------------------------------------
  // Multiple tenants / reference IDs
  // ---------------------------------------------------------------------------

  describe("different reference IDs", () => {
    it("processes multiple reference IDs independently", () => {
      chargeStore.create("ref-b-001", "tenant-b", 5000);
      chargeStore.create("ref-c-001", "tenant-c", 1500);

      handlePayRamWebhook(deps, makePayload({ reference_id: "ref-b-001", status: "FILLED" }));
      handlePayRamWebhook(deps, makePayload({ reference_id: "ref-c-001", status: "FILLED" }));

      expect(creditLedger.balance("tenant-b")).toBe(5000);
      expect(creditLedger.balance("tenant-c")).toBe(1500);
    });
  });

  // ---------------------------------------------------------------------------
  // Replay guard
  // ---------------------------------------------------------------------------

  describe("replay guard", () => {
    it("blocks duplicate reference_id + status combos", () => {
      const replayGuard = new PayRamReplayGuard();
      const depsWithGuard: PayRamWebhookDeps = { ...deps, replayGuard };

      const first = handlePayRamWebhook(depsWithGuard, makePayload({ status: "FILLED" }));
      expect(first.handled).toBe(true);
      expect(first.creditedCents).toBe(2500);
      expect(first.duplicate).toBeUndefined();

      const second = handlePayRamWebhook(depsWithGuard, makePayload({ status: "FILLED" }));
      expect(second.handled).toBe(true);
      expect(second.duplicate).toBe(true);
      expect(second.creditedCents).toBeUndefined();

      // Only credited once
      expect(creditLedger.balance("tenant-a")).toBe(2500);
    });

    it("same reference_id with different status is not blocked by replay guard", () => {
      const replayGuard = new PayRamReplayGuard();
      const depsWithGuard: PayRamWebhookDeps = { ...deps, replayGuard };

      handlePayRamWebhook(depsWithGuard, makePayload({ status: "VERIFYING" }));
      const result = handlePayRamWebhook(depsWithGuard, makePayload({ status: "FILLED" }));

      expect(result.duplicate).toBeUndefined();
      expect(result.creditedCents).toBe(2500);
    });

    it("works without replay guard (backwards compatible)", () => {
      const result = handlePayRamWebhook(deps, makePayload({ status: "FILLED" }));
      expect(result.handled).toBe(true);
      expect(result.creditedCents).toBe(2500);
    });
  });

  // ---------------------------------------------------------------------------
  // Bot reactivation
  // ---------------------------------------------------------------------------

  describe("bot reactivation", () => {
    it("calls botBilling.checkReactivation on FILLED and includes reactivatedBots in result", () => {
      const mockCheckReactivation = vi.fn().mockReturnValue(["bot-1", "bot-2"]);
      const depsWithBotBilling: PayRamWebhookDeps = {
        ...deps,
        botBilling: { checkReactivation: mockCheckReactivation } as unknown as Parameters<typeof handlePayRamWebhook>[0]["botBilling"],
      };

      const result = handlePayRamWebhook(depsWithBotBilling, makePayload({ status: "FILLED" }));

      expect(mockCheckReactivation).toHaveBeenCalledWith("tenant-a", creditLedger);
      expect(result.reactivatedBots).toEqual(["bot-1", "bot-2"]);
    });

    it("does not include reactivatedBots when no bots reactivated", () => {
      const mockCheckReactivation = vi.fn().mockReturnValue([]);
      const depsWithBotBilling: PayRamWebhookDeps = {
        ...deps,
        botBilling: { checkReactivation: mockCheckReactivation } as unknown as Parameters<typeof handlePayRamWebhook>[0]["botBilling"],
      };

      const result = handlePayRamWebhook(depsWithBotBilling, makePayload({ status: "FILLED" }));

      expect(result.reactivatedBots).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// PayRamReplayGuard unit tests
// ---------------------------------------------------------------------------

describe("PayRamReplayGuard", () => {
  it("reports unseen keys as not duplicate", () => {
    const guard = new PayRamReplayGuard();
    expect(guard.isDuplicate("ref-001:FILLED")).toBe(false);
  });

  it("reports seen keys as duplicate", () => {
    const guard = new PayRamReplayGuard();
    guard.markSeen("ref-001:FILLED");
    expect(guard.isDuplicate("ref-001:FILLED")).toBe(true);
  });

  it("expires entries after TTL", async () => {
    const guard = new PayRamReplayGuard(50);
    guard.markSeen("ref-expire:FILLED");
    expect(guard.isDuplicate("ref-expire:FILLED")).toBe(true);

    await new Promise((r) => setTimeout(r, 100));
    expect(guard.isDuplicate("ref-expire:FILLED")).toBe(false);
  });
});
