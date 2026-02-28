import { describe, expect, it, vi } from "vitest";
import { Credit } from "../monetization/credit.js";
import { type CreditGateDeps, debitCredits } from "./credit-gate.js";

describe("onDebitComplete wiring", () => {
  it("calls onDebitComplete after a successful debit", async () => {
    const onDebitComplete = vi.fn();
    const balance = vi.fn().mockResolvedValue(Credit.fromCents(500));
    const debit = vi.fn().mockResolvedValue(undefined);
    const deps: CreditGateDeps = {
      creditLedger: { balance, debit } as any,
      topUpUrl: "/billing",
      onDebitComplete,
    };

    await debitCredits(deps, "t1", 0.01, 1.0, "chat-completions", "openrouter");

    expect(onDebitComplete).toHaveBeenCalledWith("t1");
    expect(onDebitComplete).toHaveBeenCalledTimes(1);
  });

  it("does not call onDebitComplete when debit throws InsufficientBalanceError", async () => {
    const onDebitComplete = vi.fn();
    const { InsufficientBalanceError } = await import("../monetization/credits/credit-ledger.js");
    const debit = vi.fn().mockRejectedValue(new InsufficientBalanceError(Credit.fromCents(0), Credit.fromCents(100)));
    const deps: CreditGateDeps = {
      creditLedger: { debit } as any,
      topUpUrl: "/billing",
      onDebitComplete,
    };

    await debitCredits(deps, "t1", 0.01, 1.0, "chat-completions", "openrouter");

    expect(onDebitComplete).not.toHaveBeenCalled();
  });

  it("does not call onDebitComplete when creditLedger is absent", async () => {
    const onDebitComplete = vi.fn();
    const deps: CreditGateDeps = {
      topUpUrl: "/billing",
      onDebitComplete,
    };

    await debitCredits(deps, "t1", 0.01, 1.0, "chat-completions", "openrouter");

    expect(onDebitComplete).not.toHaveBeenCalled();
  });
});
