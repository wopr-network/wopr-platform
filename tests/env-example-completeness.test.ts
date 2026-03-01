import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe(".env.example completeness", () => {
  it("should contain STRIPE_CREDIT_PRICE_* vars", () => {
    const content = readFileSync(path.resolve(__dirname, "../.env.example"), "utf-8");
    expect(content).toContain("STRIPE_CREDIT_PRICE_5=");
    expect(content).toContain("STRIPE_CREDIT_PRICE_10=");
    expect(content).toContain("STRIPE_CREDIT_PRICE_25=");
    expect(content).toContain("STRIPE_CREDIT_PRICE_50=");
    expect(content).toContain("STRIPE_CREDIT_PRICE_100=");
  });

  it("should contain DATABASE_URL", () => {
    const content = readFileSync(path.resolve(__dirname, "../.env.example"), "utf-8");
    expect(content).toContain("DATABASE_URL=");
  });

  it("should contain BETTER_AUTH_URL", () => {
    const content = readFileSync(path.resolve(__dirname, "../.env.example"), "utf-8");
    expect(content).toContain("BETTER_AUTH_URL=");
  });

  it("should contain PLATFORM_SECRET", () => {
    const content = readFileSync(path.resolve(__dirname, "../.env.example"), "utf-8");
    expect(content).toContain("PLATFORM_SECRET=");
  });

  it("should contain BETTER_AUTH_SECRET", () => {
    const content = readFileSync(path.resolve(__dirname, "../.env.example"), "utf-8");
    expect(content).toContain("BETTER_AUTH_SECRET=");
  });
});
