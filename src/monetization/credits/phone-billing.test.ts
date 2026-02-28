import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Credit } from "../credit.js";
import type { IMeterEmitter } from "../metering/emitter.js";
import type { CreditTransaction, ICreditLedger } from "./credit-ledger.js";
import { InsufficientBalanceError } from "./credit-ledger.js";
import type { IPhoneNumberRepository } from "./drizzle-phone-number-repository.js";
import { PHONE_NUMBER_MONTHLY_COST, runMonthlyPhoneBilling } from "./phone-billing.js";
import type { ProvisionedPhoneNumber } from "./repository-types.js";

function makeTx(tenantId: string): CreditTransaction {
  return {
    id: "tx-1",
    tenantId,
    amount: Credit.fromDollars(1),
    balanceAfter: Credit.fromDollars(100),
    type: "addon",
    description: "Monthly phone number fee",
    referenceId: null,
    fundingSource: null,
    attributedUserId: null,
    createdAt: new Date().toISOString(),
  };
}

function makeNumber(overrides: Partial<ProvisionedPhoneNumber> = {}): ProvisionedPhoneNumber {
  return {
    sid: "PN-abc123",
    tenantId: "tenant-1",
    phoneNumber: "+15551234567",
    provisionedAt: "2025-01-01T00:00:00.000Z",
    lastBilledAt: null,
    ...overrides,
  };
}

describe("runMonthlyPhoneBilling", () => {
  let phoneRepo: {
    listActivePhoneNumbers: ReturnType<typeof vi.fn>;
    markBilled: ReturnType<typeof vi.fn>;
    trackPhoneNumber: ReturnType<typeof vi.fn>;
    removePhoneNumber: ReturnType<typeof vi.fn>;
    listByTenant: ReturnType<typeof vi.fn>;
  };
  let ledger: {
    debit: ReturnType<typeof vi.fn>;
    credit: ReturnType<typeof vi.fn>;
    balance: ReturnType<typeof vi.fn>;
    hasReferenceId: ReturnType<typeof vi.fn>;
    history: ReturnType<typeof vi.fn>;
    tenantsWithBalance: ReturnType<typeof vi.fn>;
    memberUsage: ReturnType<typeof vi.fn>;
  };
  let meter: {
    emit: ReturnType<typeof vi.fn>;
    flush: ReturnType<typeof vi.fn>;
    pending: number;
    close: ReturnType<typeof vi.fn>;
    queryEvents: ReturnType<typeof vi.fn>;
  };

  const NOW = new Date("2026-02-15T12:00:00.000Z");

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    phoneRepo = {
      listActivePhoneNumbers: vi.fn().mockResolvedValue([]),
      markBilled: vi.fn().mockResolvedValue(undefined),
      trackPhoneNumber: vi.fn().mockResolvedValue(undefined),
      removePhoneNumber: vi.fn().mockResolvedValue(undefined),
      listByTenant: vi.fn().mockResolvedValue([]),
    };

    ledger = {
      debit: vi.fn().mockResolvedValue(makeTx("tenant-1")),
      credit: vi.fn(),
      balance: vi.fn(),
      hasReferenceId: vi.fn(),
      history: vi.fn(),
      tenantsWithBalance: vi.fn(),
      memberUsage: vi.fn(),
    };

    meter = {
      emit: vi.fn(),
      flush: vi.fn().mockResolvedValue(0),
      pending: 0,
      close: vi.fn(),
      queryEvents: vi.fn().mockResolvedValue([]),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should return empty results when there are zero active numbers", async () => {
    phoneRepo.listActivePhoneNumbers.mockResolvedValue([]);

    const result = await runMonthlyPhoneBilling(
      phoneRepo as unknown as IPhoneNumberRepository,
      ledger as unknown as ICreditLedger,
      meter as unknown as IMeterEmitter,
    );

    expect(result.processed).toBe(0);
    expect(result.billed).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(ledger.debit).not.toHaveBeenCalled();
    expect(meter.emit).not.toHaveBeenCalled();
  });

  it("should bill a single number that is due (happy path)", async () => {
    const number = makeNumber({
      provisionedAt: "2025-12-01T00:00:00.000Z", // > 30 days ago from NOW
      lastBilledAt: null,
    });
    phoneRepo.listActivePhoneNumbers.mockResolvedValue([number]);

    const result = await runMonthlyPhoneBilling(
      phoneRepo as unknown as IPhoneNumberRepository,
      ledger as unknown as ICreditLedger,
      meter as unknown as IMeterEmitter,
    );

    expect(result.processed).toBe(1);
    expect(result.billed).toEqual([{ tenantId: "tenant-1", sid: "PN-abc123", cost: PHONE_NUMBER_MONTHLY_COST }]);
    expect(result.failed).toEqual([]);

    // Verify debit was called with the margined charge amount
    expect(ledger.debit).toHaveBeenCalledOnce();
    const [tenantId, chargeAmount, type, description, referenceId, allowNegative] = ledger.debit.mock.calls[0];
    expect(tenantId).toBe("tenant-1");
    // chargeCredit = Credit.fromDollars(1.15).multiply(2.6)
    const expectedCharge = Credit.fromDollars(1.15).multiply(2.6);
    expect(chargeAmount.toRaw()).toBe(expectedCharge.toRaw());
    expect(type).toBe("addon");
    expect(description).toBe("Monthly phone number fee");
    expect(referenceId).toMatch(/^phone-billing:PN-abc123:2026-02$/);
    expect(allowNegative).toBe(true);

    // Verify meter emission
    expect(meter.emit).toHaveBeenCalledOnce();
    const event = meter.emit.mock.calls[0][0];
    expect(event.tenant).toBe("tenant-1");
    expect(event.capability).toBe("phone-number-monthly");
    expect(event.provider).toBe("twilio");

    // Verify markBilled
    expect(phoneRepo.markBilled).toHaveBeenCalledWith("PN-abc123");
  });

  it("should bill multiple numbers and sum results correctly", async () => {
    const numbers = [
      makeNumber({ sid: "PN-001", tenantId: "t-1", provisionedAt: "2025-01-01T00:00:00.000Z" }),
      makeNumber({ sid: "PN-002", tenantId: "t-2", provisionedAt: "2025-06-01T00:00:00.000Z" }),
      makeNumber({ sid: "PN-003", tenantId: "t-1", provisionedAt: "2025-11-01T00:00:00.000Z" }),
    ];
    phoneRepo.listActivePhoneNumbers.mockResolvedValue(numbers);

    const result = await runMonthlyPhoneBilling(
      phoneRepo as unknown as IPhoneNumberRepository,
      ledger as unknown as ICreditLedger,
      meter as unknown as IMeterEmitter,
    );

    expect(result.processed).toBe(3);
    expect(result.billed).toHaveLength(3);
    expect(result.failed).toEqual([]);
    expect(ledger.debit).toHaveBeenCalledTimes(3);
    expect(phoneRepo.markBilled).toHaveBeenCalledTimes(3);
    expect(meter.emit).toHaveBeenCalledTimes(3);
  });

  it("should skip numbers billed within the last 30 days", async () => {
    const recentlyBilled = makeNumber({
      provisionedAt: "2025-01-01T00:00:00.000Z",
      lastBilledAt: "2026-02-01T00:00:00.000Z", // 14 days ago, within 30
    });
    phoneRepo.listActivePhoneNumbers.mockResolvedValue([recentlyBilled]);

    const result = await runMonthlyPhoneBilling(
      phoneRepo as unknown as IPhoneNumberRepository,
      ledger as unknown as ICreditLedger,
      meter as unknown as IMeterEmitter,
    );

    expect(result.processed).toBe(1);
    expect(result.billed).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(ledger.debit).not.toHaveBeenCalled();
  });

  it("should catch InsufficientBalanceError and push to failed (not rethrow)", async () => {
    const number = makeNumber({ provisionedAt: "2025-01-01T00:00:00.000Z" });
    phoneRepo.listActivePhoneNumbers.mockResolvedValue([number]);
    ledger.debit.mockRejectedValue(new InsufficientBalanceError(Credit.fromDollars(0), Credit.fromDollars(2.99)));

    const result = await runMonthlyPhoneBilling(
      phoneRepo as unknown as IPhoneNumberRepository,
      ledger as unknown as ICreditLedger,
      meter as unknown as IMeterEmitter,
    );

    expect(result.processed).toBe(1);
    expect(result.billed).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].tenantId).toBe("tenant-1");
    expect(result.failed[0].error).toContain("Insufficient balance");
    // Should NOT have called markBilled or meter.emit
    expect(phoneRepo.markBilled).not.toHaveBeenCalled();
    expect(meter.emit).not.toHaveBeenCalled();
  });

  it("should catch generic debit errors and push to failed (not rethrow)", async () => {
    const number = makeNumber({ provisionedAt: "2025-01-01T00:00:00.000Z" });
    phoneRepo.listActivePhoneNumbers.mockResolvedValue([number]);
    ledger.debit.mockRejectedValue(new Error("DB connection lost"));

    const result = await runMonthlyPhoneBilling(
      phoneRepo as unknown as IPhoneNumberRepository,
      ledger as unknown as ICreditLedger,
      meter as unknown as IMeterEmitter,
    );

    expect(result.processed).toBe(1);
    expect(result.billed).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].error).toBe("DB connection lost");
    expect(phoneRepo.markBilled).not.toHaveBeenCalled();
    expect(meter.emit).not.toHaveBeenCalled();
  });

  it("should use provisionedAt when lastBilledAt is null for 30-day check", async () => {
    // provisionedAt is 25 days ago — should NOT be billed yet
    const twentyFiveDaysAgo = new Date(NOW.getTime() - 25 * 24 * 60 * 60 * 1000).toISOString();
    const number = makeNumber({
      provisionedAt: twentyFiveDaysAgo,
      lastBilledAt: null,
    });
    phoneRepo.listActivePhoneNumbers.mockResolvedValue([number]);

    const result = await runMonthlyPhoneBilling(
      phoneRepo as unknown as IPhoneNumberRepository,
      ledger as unknown as ICreditLedger,
      meter as unknown as IMeterEmitter,
    );

    expect(result.processed).toBe(1);
    expect(result.billed).toEqual([]);
    expect(ledger.debit).not.toHaveBeenCalled();
  });

  it("should continue billing remaining numbers after one fails", async () => {
    const numbers = [
      makeNumber({ sid: "PN-fail", tenantId: "t-fail", provisionedAt: "2025-01-01T00:00:00.000Z" }),
      makeNumber({ sid: "PN-ok", tenantId: "t-ok", provisionedAt: "2025-01-01T00:00:00.000Z" }),
    ];
    phoneRepo.listActivePhoneNumbers.mockResolvedValue(numbers);
    ledger.debit.mockRejectedValueOnce(new Error("fail")).mockResolvedValueOnce(makeTx("t-ok"));

    const result = await runMonthlyPhoneBilling(
      phoneRepo as unknown as IPhoneNumberRepository,
      ledger as unknown as ICreditLedger,
      meter as unknown as IMeterEmitter,
    );

    expect(result.processed).toBe(2);
    expect(result.billed).toHaveLength(1);
    expect(result.billed[0].sid).toBe("PN-ok");
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].tenantId).toBe("t-fail");
  });
});
