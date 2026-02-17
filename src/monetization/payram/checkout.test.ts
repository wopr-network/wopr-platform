/**
 * Unit tests for createPayRamCheckout (WOP-407).
 */
import BetterSqlite3 from "better-sqlite3";
import type { Payram } from "payram";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb } from "../../db/index.js";
import { PayRamChargeStore } from "./charge-store.js";
import { createPayRamCheckout, MIN_PAYMENT_USD } from "./checkout.js";
import { initPayRamSchema } from "./schema.js";

function createMockPayram(
  overrides: { initiatePayment?: ReturnType<typeof vi.fn> } = {},
): Payram {
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
  let sqlite: BetterSqlite3.Database;
  let chargeStore: PayRamChargeStore;
  let payram: Payram;

  beforeEach(() => {
    sqlite = new BetterSqlite3(":memory:");
    initPayRamSchema(sqlite);
    const db = createDb(sqlite);
    chargeStore = new PayRamChargeStore(db);
    payram = createMockPayram();
  });

  afterEach(() => {
    sqlite.close();
  });

  it("rejects amounts below $10 minimum", async () => {
    await expect(
      createPayRamCheckout(payram, chargeStore, { tenant: "t-1", amountUsd: 5 }),
    ).rejects.toThrow(`Minimum payment amount is $${MIN_PAYMENT_USD}`);
  });

  it("rejects amounts of exactly $0", async () => {
    await expect(
      createPayRamCheckout(payram, chargeStore, { tenant: "t-1", amountUsd: 0 }),
    ).rejects.toThrow();
  });

  it("calls payram.payments.initiatePayment with correct params", async () => {
    const initiatePayment = vi.fn().mockResolvedValue({
      reference_id: "ref-abc",
      url: "https://payram.example.com/pay/ref-abc",
    });
    const mockPayram = createMockPayram({ initiatePayment });

    await createPayRamCheckout(mockPayram, chargeStore, { tenant: "t-test", amountUsd: 25 });

    expect(initiatePayment).toHaveBeenCalledWith({
      customerEmail: "t-test@wopr.network",
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

    const charge = chargeStore.getByReferenceId("ref-store-test");
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
    await expect(
      createPayRamCheckout(payram, chargeStore, { tenant: "t-4", amountUsd: 10 }),
    ).resolves.toBeDefined();
  });
});
