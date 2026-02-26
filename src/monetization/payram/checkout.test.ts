/**
 * Unit tests for createPayRamCheckout (WOP-407).
 */
import type { PGlite } from "@electric-sql/pglite";
import type { Payram } from "payram";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../../test/db.js";
import { PayRamChargeStore } from "./charge-store.js";
import { createPayRamCheckout, MIN_PAYMENT_USD } from "./checkout.js";

function createMockPayram(overrides: { initiatePayment?: ReturnType<typeof vi.fn> } = {}): Payram {
  return {
    payments: {
      initiatePayment:
        overrides.initiatePayment ??
        vi.fn().mockResolvedValue({
          reference_id: "ref-mock-001",
          url: "https://payram.example.com/pay/ref-mock-001",
        }),
    },
  } as unknown as Payram;
}

describe("createPayRamCheckout", () => {
  let pool: PGlite;
  let chargeStore: PayRamChargeStore;
  let payram: Payram;

  beforeEach(async () => {
    const { db, pool: p } = await createTestDb();
    pool = p;
    chargeStore = new PayRamChargeStore(db);
    payram = createMockPayram();
  });

  afterEach(async () => {
    await pool.close();
  });

  it("rejects amounts below $10 minimum", async () => {
    await expect(createPayRamCheckout(payram, chargeStore, { tenant: "t-1", amountUsd: 5 })).rejects.toThrow(
      `Minimum payment amount is $${MIN_PAYMENT_USD}`,
    );
  });

  it("rejects amounts of exactly $0", async () => {
    await expect(createPayRamCheckout(payram, chargeStore, { tenant: "t-1", amountUsd: 0 })).rejects.toThrow();
  });

  it("calls payram.payments.initiatePayment with correct params", async () => {
    const initiatePayment = vi.fn().mockResolvedValue({
      reference_id: "ref-abc",
      url: "https://payram.example.com/pay/ref-abc",
    });
    const mockPayram = createMockPayram({ initiatePayment });

    await createPayRamCheckout(mockPayram, chargeStore, { tenant: "t-test", amountUsd: 25 });

    expect(initiatePayment).toHaveBeenCalledWith({
      customerEmail: "t-test@wopr.bot",
      customerId: "t-test",
      amountInUSD: 25,
    });
  });

  it("stores the charge with correct amountUsdCents (converts from USD)", async () => {
    const initiatePayment = vi.fn().mockResolvedValue({
      reference_id: "ref-store-test",
      url: "https://payram.example.com/pay/ref-store-test",
    });
    const mockPayram = createMockPayram({ initiatePayment });

    await createPayRamCheckout(mockPayram, chargeStore, { tenant: "t-2", amountUsd: 25 });

    const charge = await chargeStore.getByReferenceId("ref-store-test");
    expect(charge).not.toBeNull();
    expect(charge?.tenantId).toBe("t-2");
    expect(charge?.amountUsdCents).toBe(2500); // $25.00 = 2500 cents
    expect(charge?.status).toBe("OPEN");
  });

  it("returns referenceId and url from PayRam response", async () => {
    const result = await createPayRamCheckout(payram, chargeStore, { tenant: "t-3", amountUsd: 10 });

    expect(result.referenceId).toBe("ref-mock-001");
    expect(result.url).toBe("https://payram.example.com/pay/ref-mock-001");
  });

  it("accepts exactly $10 (minimum boundary)", async () => {
    await expect(createPayRamCheckout(payram, chargeStore, { tenant: "t-4", amountUsd: 10 })).resolves.toBeDefined();
  });
});
