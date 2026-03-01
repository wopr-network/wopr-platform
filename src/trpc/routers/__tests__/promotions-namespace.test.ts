import { describe, expect, it } from "vitest";
import { appRouter } from "../../index.js";

describe("tRPC namespace structure", () => {
  it("exposes promotions at the root namespace", () => {
    expect(appRouter.promotions).toBeDefined();
  });

  it("exposes rateOverrides at the root namespace", () => {
    expect(appRouter.rateOverrides).toBeDefined();
  });

  it("does NOT double-nest promotions under promotions.promotions", () => {
    // If double-nesting were present, appRouter.promotions would have a
    // nested .promotions property. After the fix it should not.
    expect((appRouter.promotions as Record<string, unknown>).promotions).toBeUndefined();
  });
});
