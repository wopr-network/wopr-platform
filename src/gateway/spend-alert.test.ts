import { describe, expect, it, vi } from "vitest";
import { checkSpendAlert, type SpendAlertDeps } from "./spend-alert.js";

vi.mock("../config/logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

function makeDeps(overrides: Partial<SpendAlertDeps> = {}): SpendAlertDeps {
  return {
    spendingLimitsRepo: {
      get: vi.fn().mockResolvedValue({ global: { alertAt: null, hardCap: null }, perCapability: {} }),
      upsert: vi.fn(),
    },
    spendingCapStore: {
      querySpend: vi.fn().mockResolvedValue({ dailySpend: 0, monthlySpend: 0 }),
    },
    billingEmailRepo: {
      shouldSend: vi.fn().mockResolvedValue(true),
      recordSent: vi.fn().mockResolvedValue(undefined),
    },
    notificationService: { notifySpendThresholdAlert: vi.fn() },
    resolveEmail: vi.fn().mockResolvedValue("user@test.com"),
    ...overrides,
  };
}

describe("checkSpendAlert", () => {
  it("does nothing when alertAt is null", async () => {
    const deps = makeDeps();
    await checkSpendAlert(deps, "t1");
    expect(deps.notificationService.notifySpendThresholdAlert).not.toHaveBeenCalled();
  });

  it("does nothing when monthly spend is below alertAt", async () => {
    const deps = makeDeps({
      spendingLimitsRepo: {
        get: vi.fn().mockResolvedValue({ global: { alertAt: 50, hardCap: null }, perCapability: {} }),
        upsert: vi.fn(),
      },
      spendingCapStore: {
        querySpend: vi.fn().mockResolvedValue({ dailySpend: 5, monthlySpend: 30 }),
      },
    });
    await checkSpendAlert(deps, "t1");
    expect(deps.notificationService.notifySpendThresholdAlert).not.toHaveBeenCalled();
  });

  it("fires alert when monthly spend crosses alertAt", async () => {
    const deps = makeDeps({
      spendingLimitsRepo: {
        get: vi.fn().mockResolvedValue({ global: { alertAt: 50, hardCap: null }, perCapability: {} }),
        upsert: vi.fn(),
      },
      spendingCapStore: {
        querySpend: vi.fn().mockResolvedValue({ dailySpend: 10, monthlySpend: 55 }),
      },
    });
    await checkSpendAlert(deps, "t1");
    expect(deps.billingEmailRepo.shouldSend).toHaveBeenCalledWith("t1", "spend-alert");
    expect(deps.billingEmailRepo.recordSent).toHaveBeenCalledWith("t1", "spend-alert");
    expect(deps.notificationService.notifySpendThresholdAlert).toHaveBeenCalledWith(
      "t1",
      "user@test.com",
      "$55.00",
      "$50.00",
    );
  });

  it("does not fire twice (dedup)", async () => {
    const deps = makeDeps({
      spendingLimitsRepo: {
        get: vi.fn().mockResolvedValue({ global: { alertAt: 50, hardCap: null }, perCapability: {} }),
        upsert: vi.fn(),
      },
      spendingCapStore: {
        querySpend: vi.fn().mockResolvedValue({ dailySpend: 10, monthlySpend: 55 }),
      },
      billingEmailRepo: {
        shouldSend: vi.fn().mockResolvedValue(false),
        recordSent: vi.fn(),
      },
    });
    await checkSpendAlert(deps, "t1");
    expect(deps.notificationService.notifySpendThresholdAlert).not.toHaveBeenCalled();
  });

  it("does nothing when no email found for tenant", async () => {
    const deps = makeDeps({
      spendingLimitsRepo: {
        get: vi.fn().mockResolvedValue({ global: { alertAt: 50, hardCap: null }, perCapability: {} }),
        upsert: vi.fn(),
      },
      spendingCapStore: {
        querySpend: vi.fn().mockResolvedValue({ dailySpend: 10, monthlySpend: 55 }),
      },
      resolveEmail: vi.fn().mockResolvedValue(null),
    });
    await checkSpendAlert(deps, "t1");
    expect(deps.notificationService.notifySpendThresholdAlert).not.toHaveBeenCalled();
  });

  it("fires at exact threshold", async () => {
    const deps = makeDeps({
      spendingLimitsRepo: {
        get: vi.fn().mockResolvedValue({ global: { alertAt: 50, hardCap: null }, perCapability: {} }),
        upsert: vi.fn(),
      },
      spendingCapStore: {
        querySpend: vi.fn().mockResolvedValue({ dailySpend: 10, monthlySpend: 50 }),
      },
    });
    await checkSpendAlert(deps, "t1");
    expect(deps.notificationService.notifySpendThresholdAlert).toHaveBeenCalled();
  });
});
