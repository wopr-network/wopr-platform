import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "./config/logger.js";
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

  it("throws when PLATFORM_ENCRYPTION_SECRET is missing", () => {
    vi.stubEnv("PLATFORM_SECRET", "a".repeat(32));
    vi.stubEnv("DATABASE_URL", "postgresql://x");
    vi.stubEnv("BETTER_AUTH_SECRET", "a".repeat(32));
    vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3100");
    // PLATFORM_ENCRYPTION_SECRET not set
    expect(() => validateRequiredEnvVars()).toThrow("PLATFORM_ENCRYPTION_SECRET");
  });

  it("throws when PLATFORM_ENCRYPTION_SECRET is too short", () => {
    vi.stubEnv("PLATFORM_SECRET", "a".repeat(32));
    vi.stubEnv("PLATFORM_ENCRYPTION_SECRET", "short");
    vi.stubEnv("DATABASE_URL", "postgresql://x");
    vi.stubEnv("BETTER_AUTH_SECRET", "a".repeat(32));
    vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3100");
    expect(() => validateRequiredEnvVars()).toThrow("at least 32 characters");
  });

  it("throws when PLATFORM_ENCRYPTION_SECRET is placeholder REPLACE_ME", () => {
    vi.stubEnv("PLATFORM_SECRET", "a".repeat(32));
    vi.stubEnv("PLATFORM_ENCRYPTION_SECRET", "REPLACE_ME");
    vi.stubEnv("DATABASE_URL", "postgresql://x");
    vi.stubEnv("BETTER_AUTH_SECRET", "a".repeat(32));
    vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3100");
    expect(() => validateRequiredEnvVars()).toThrow("real secret");
  });

  it("throws when PLATFORM_ENCRYPTION_SECRET is whitespace only", () => {
    vi.stubEnv("PLATFORM_SECRET", "a".repeat(32));
    vi.stubEnv("PLATFORM_ENCRYPTION_SECRET", "   ");
    vi.stubEnv("DATABASE_URL", "postgresql://x");
    vi.stubEnv("BETTER_AUTH_SECRET", "a".repeat(32));
    vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3100");
    expect(() => validateRequiredEnvVars()).toThrow("PLATFORM_ENCRYPTION_SECRET");
  });

  it("warns (does not throw) when STRIPE_CREDIT_PRICE_* are missing", () => {
    vi.stubEnv("PLATFORM_SECRET", "a".repeat(32));
    vi.stubEnv("DATABASE_URL", "postgresql://x");
    vi.stubEnv("BETTER_AUTH_SECRET", "a".repeat(32));
    vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3100");
    vi.stubEnv("PLATFORM_ENCRYPTION_SECRET", "b".repeat(32));
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => logger);
    expect(() => validateRequiredEnvVars()).not.toThrow();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("STRIPE_CREDIT_PRICE_"));
    warnSpy.mockRestore();
  });

  it("does not throw when all required vars are set", () => {
    vi.stubEnv("PLATFORM_SECRET", "a".repeat(32));
    vi.stubEnv("DATABASE_URL", "postgresql://x");
    vi.stubEnv("BETTER_AUTH_SECRET", "a".repeat(32));
    vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3100");
    vi.stubEnv("PLATFORM_ENCRYPTION_SECRET", "b".repeat(32));
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_abc");
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_abc");
    vi.stubEnv("STRIPE_CREDIT_PRICE_5", "price_x");
    vi.stubEnv("STRIPE_CREDIT_PRICE_10", "price_x");
    vi.stubEnv("STRIPE_CREDIT_PRICE_25", "price_x");
    vi.stubEnv("STRIPE_CREDIT_PRICE_50", "price_x");
    vi.stubEnv("STRIPE_CREDIT_PRICE_100", "price_x");
    vi.stubEnv("PLATFORM_UI_URL", "https://app.example.com");
    vi.stubEnv("PLATFORM_URL", "https://api.example.com");
    vi.stubEnv("PLATFORM_DOMAIN", "example.com");
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => logger);
    expect(() => validateRequiredEnvVars()).not.toThrow();
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("skips validation in test env", () => {
    vi.stubEnv("NODE_ENV", "test");
    // Nothing set — should not throw
    expect(() => validateRequiredEnvVars()).not.toThrow();
  });

  it("warns when STRIPE_SECRET_KEY is not set", () => {
    vi.stubEnv("PLATFORM_SECRET", "a".repeat(32));
    vi.stubEnv("DATABASE_URL", "postgresql://x");
    vi.stubEnv("BETTER_AUTH_SECRET", "a".repeat(32));
    vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3100");
    vi.stubEnv("PLATFORM_ENCRYPTION_SECRET", "b".repeat(32));
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_test_value");
    vi.stubEnv("STRIPE_CREDIT_PRICE_5", "price_x");
    vi.stubEnv("STRIPE_CREDIT_PRICE_10", "price_x");
    vi.stubEnv("STRIPE_CREDIT_PRICE_25", "price_x");
    vi.stubEnv("STRIPE_CREDIT_PRICE_50", "price_x");
    vi.stubEnv("STRIPE_CREDIT_PRICE_100", "price_x");
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => logger);
    validateRequiredEnvVars();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("STRIPE_SECRET_KEY"));
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining("STRIPE_WEBHOOK_SECRET"));
    warnSpy.mockRestore();
  });

  it("warns when STRIPE_WEBHOOK_SECRET is not set", () => {
    vi.stubEnv("PLATFORM_SECRET", "a".repeat(32));
    vi.stubEnv("DATABASE_URL", "postgresql://x");
    vi.stubEnv("BETTER_AUTH_SECRET", "a".repeat(32));
    vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3100");
    vi.stubEnv("PLATFORM_ENCRYPTION_SECRET", "b".repeat(32));
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_abc");
    vi.stubEnv("STRIPE_CREDIT_PRICE_5", "price_x");
    vi.stubEnv("STRIPE_CREDIT_PRICE_10", "price_x");
    vi.stubEnv("STRIPE_CREDIT_PRICE_25", "price_x");
    vi.stubEnv("STRIPE_CREDIT_PRICE_50", "price_x");
    vi.stubEnv("STRIPE_CREDIT_PRICE_100", "price_x");
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => logger);
    validateRequiredEnvVars();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("STRIPE_WEBHOOK_SECRET"));
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining("STRIPE_SECRET_KEY"));
    warnSpy.mockRestore();
  });

  it("warns when PLATFORM_UI_URL is not set", () => {
    vi.stubEnv("PLATFORM_SECRET", "a".repeat(32));
    vi.stubEnv("DATABASE_URL", "postgresql://x");
    vi.stubEnv("BETTER_AUTH_SECRET", "a".repeat(32));
    vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3100");
    vi.stubEnv("PLATFORM_ENCRYPTION_SECRET", "b".repeat(32));
    vi.stubEnv("STRIPE_CREDIT_PRICE_5", "price_x");
    vi.stubEnv("STRIPE_CREDIT_PRICE_10", "price_x");
    vi.stubEnv("STRIPE_CREDIT_PRICE_25", "price_x");
    vi.stubEnv("STRIPE_CREDIT_PRICE_50", "price_x");
    vi.stubEnv("STRIPE_CREDIT_PRICE_100", "price_x");
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => logger);
    validateRequiredEnvVars();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("PLATFORM_UI_URL"));
    warnSpy.mockRestore();
  });

  it("warns when PLATFORM_URL is not set", () => {
    vi.stubEnv("PLATFORM_SECRET", "a".repeat(32));
    vi.stubEnv("DATABASE_URL", "postgresql://x");
    vi.stubEnv("BETTER_AUTH_SECRET", "a".repeat(32));
    vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3100");
    vi.stubEnv("PLATFORM_ENCRYPTION_SECRET", "b".repeat(32));
    vi.stubEnv("STRIPE_CREDIT_PRICE_5", "price_x");
    vi.stubEnv("STRIPE_CREDIT_PRICE_10", "price_x");
    vi.stubEnv("STRIPE_CREDIT_PRICE_25", "price_x");
    vi.stubEnv("STRIPE_CREDIT_PRICE_50", "price_x");
    vi.stubEnv("STRIPE_CREDIT_PRICE_100", "price_x");
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => logger);
    validateRequiredEnvVars();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("PLATFORM_URL"));
    warnSpy.mockRestore();
  });

  it("warns when PLATFORM_DOMAIN is not set", () => {
    vi.stubEnv("PLATFORM_SECRET", "a".repeat(32));
    vi.stubEnv("DATABASE_URL", "postgresql://x");
    vi.stubEnv("BETTER_AUTH_SECRET", "a".repeat(32));
    vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3100");
    vi.stubEnv("PLATFORM_ENCRYPTION_SECRET", "b".repeat(32));
    vi.stubEnv("STRIPE_CREDIT_PRICE_5", "price_x");
    vi.stubEnv("STRIPE_CREDIT_PRICE_10", "price_x");
    vi.stubEnv("STRIPE_CREDIT_PRICE_25", "price_x");
    vi.stubEnv("STRIPE_CREDIT_PRICE_50", "price_x");
    vi.stubEnv("STRIPE_CREDIT_PRICE_100", "price_x");
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => logger);
    validateRequiredEnvVars();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("PLATFORM_DOMAIN"));
    warnSpy.mockRestore();
  });
});
