import { afterEach, describe, expect, it } from "vitest";
import { mapBudgetError } from "./error-mapping.js";

describe("mapBudgetError", () => {
  const original = process.env.PLATFORM_UI_URL;

  afterEach(() => {
    if (original) process.env.PLATFORM_UI_URL = original;
    else delete process.env.PLATFORM_UI_URL;
  });

  it("uses PLATFORM_UI_URL in budget error message", () => {
    process.env.PLATFORM_UI_URL = "https://custom.example.com";
    const result = mapBudgetError("Budget exceeded");
    expect(result.body.error.message).toContain("https://custom.example.com/billing");
  });

  it("falls back to app.wopr.bot when PLATFORM_UI_URL is not set", () => {
    delete process.env.PLATFORM_UI_URL;
    const result = mapBudgetError("Budget exceeded");
    expect(result.body.error.message).toContain("https://app.wopr.bot/billing");
  });
});
