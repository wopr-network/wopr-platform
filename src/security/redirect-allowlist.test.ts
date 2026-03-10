import { assertSafeRedirectUrl } from "@wopr-network/platform-core/security";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("assertSafeRedirectUrl", () => {
  it("allows https://app.wopr.bot paths", () => {
    expect(() => assertSafeRedirectUrl("https://app.wopr.bot/billing/success")).not.toThrow();
  });

  it("allows https://app.wopr.bot with query params", () => {
    expect(() => assertSafeRedirectUrl("https://app.wopr.bot/dashboard?vps=activated")).not.toThrow();
  });

  it("allows https://wopr.network paths", () => {
    expect(() => assertSafeRedirectUrl("https://wopr.network/welcome")).not.toThrow();
  });

  it("allows http://localhost:3000 in dev", () => {
    expect(() => assertSafeRedirectUrl("http://localhost:3000/billing")).not.toThrow();
  });

  it("allows http://localhost:3001 in dev", () => {
    expect(() => assertSafeRedirectUrl("http://localhost:3001/billing")).not.toThrow();
  });

  it("rejects external domains", () => {
    expect(() => assertSafeRedirectUrl("https://evil.com/phishing")).toThrow("Invalid redirect URL");
  });

  it("rejects subdomain spoofing (app.wopr.bot.evil.com)", () => {
    expect(() => assertSafeRedirectUrl("https://app.wopr.bot.evil.com/phishing")).toThrow("Invalid redirect URL");
  });

  it("rejects non-URL strings", () => {
    expect(() => assertSafeRedirectUrl("not-a-url")).toThrow("Invalid redirect URL");
  });

  it("rejects javascript: URIs", () => {
    expect(() => assertSafeRedirectUrl("javascript:alert(1)")).toThrow("Invalid redirect URL");
  });

  it("rejects data: URIs", () => {
    expect(() => assertSafeRedirectUrl("data:text/html,<h1>pwned</h1>")).toThrow("Invalid redirect URL");
  });

  it("rejects empty string", () => {
    expect(() => assertSafeRedirectUrl("")).toThrow("Invalid redirect URL");
  });

  describe("PLATFORM_UI_URL env-driven entry", () => {
    beforeEach(() => {
      process.env.PLATFORM_UI_URL = "https://platform.example.com";
      vi.resetModules();
    });

    afterEach(() => {
      delete process.env.PLATFORM_UI_URL;
      vi.resetModules();
    });

    it("allows PLATFORM_UI_URL when set", async () => {
      const { assertSafeRedirectUrl: assertSafe } = await import("@wopr-network/platform-core/security");
      expect(() => assertSafe("https://platform.example.com/dashboard")).not.toThrow();
    });

    it("rejects URLs not matching PLATFORM_UI_URL", async () => {
      const { assertSafeRedirectUrl: assertSafe } = await import("@wopr-network/platform-core/security");
      expect(() => assertSafe("https://other.example.com/dashboard")).toThrow("Invalid redirect URL");
    });
  });
});
