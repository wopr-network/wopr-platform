import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateRequiredEnvVars } from "./validate-env.js";

describe("validateRequiredEnvVars", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "production");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("throws when PLATFORM_SECRET is missing", () => {
    vi.stubEnv("DATABASE_URL", "postgresql://x");
    vi.stubEnv("BETTER_AUTH_SECRET", "a".repeat(32));
    vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3100");
    // PLATFORM_SECRET not set
    expect(() => validateRequiredEnvVars()).toThrow("PLATFORM_SECRET");
  });

  it("throws when PLATFORM_SECRET is too short", () => {
    vi.stubEnv("PLATFORM_SECRET", "short");
    vi.stubEnv("DATABASE_URL", "postgresql://x");
    vi.stubEnv("BETTER_AUTH_SECRET", "a".repeat(32));
    vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3100");
    expect(() => validateRequiredEnvVars()).toThrow("at least 32 characters");
  });

  it("throws when DATABASE_URL is missing", () => {
    vi.stubEnv("PLATFORM_SECRET", "a".repeat(32));
    vi.stubEnv("BETTER_AUTH_SECRET", "a".repeat(32));
    vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3100");
    // DATABASE_URL not set
    expect(() => validateRequiredEnvVars()).toThrow("DATABASE_URL");
  });

  it("throws when BETTER_AUTH_SECRET is missing", () => {
    vi.stubEnv("PLATFORM_SECRET", "a".repeat(32));
    vi.stubEnv("DATABASE_URL", "postgresql://x");
    vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3100");
    expect(() => validateRequiredEnvVars()).toThrow("BETTER_AUTH_SECRET");
  });

  it("warns (does not throw) when STRIPE_CREDIT_PRICE_* are missing", () => {
    vi.stubEnv("PLATFORM_SECRET", "a".repeat(32));
    vi.stubEnv("DATABASE_URL", "postgresql://x");
    vi.stubEnv("BETTER_AUTH_SECRET", "a".repeat(32));
    vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3100");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => validateRequiredEnvVars()).not.toThrow();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("STRIPE_CREDIT_PRICE_"));
    warnSpy.mockRestore();
  });

  it("does not throw when all required vars are set", () => {
    vi.stubEnv("PLATFORM_SECRET", "a".repeat(32));
    vi.stubEnv("DATABASE_URL", "postgresql://x");
    vi.stubEnv("BETTER_AUTH_SECRET", "a".repeat(32));
    vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3100");
    vi.stubEnv("STRIPE_CREDIT_PRICE_5", "price_x");
    vi.stubEnv("STRIPE_CREDIT_PRICE_10", "price_x");
    vi.stubEnv("STRIPE_CREDIT_PRICE_25", "price_x");
    vi.stubEnv("STRIPE_CREDIT_PRICE_50", "price_x");
    vi.stubEnv("STRIPE_CREDIT_PRICE_100", "price_x");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => validateRequiredEnvVars()).not.toThrow();
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("skips validation in test env", () => {
    vi.stubEnv("NODE_ENV", "test");
    // Nothing set — should not throw
    expect(() => validateRequiredEnvVars()).not.toThrow();
  });
});
