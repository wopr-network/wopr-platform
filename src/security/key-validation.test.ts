import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROVIDER_ENDPOINTS, validateProviderKey } from "./key-validation.js";

describe("key-validation", () => {
  describe("PROVIDER_ENDPOINTS", () => {
    it("has entries for all supported providers", () => {
      expect(PROVIDER_ENDPOINTS.anthropic).toBeDefined();
      expect(PROVIDER_ENDPOINTS.openai).toBeDefined();
      expect(PROVIDER_ENDPOINTS.google).toBeDefined();
      expect(PROVIDER_ENDPOINTS.discord).toBeDefined();
    });

    it("anthropic headers include x-api-key", () => {
      const headers = PROVIDER_ENDPOINTS.anthropic.headers("test-key");
      expect(headers["x-api-key"]).toBe("test-key");
      expect(headers["anthropic-version"]).toBe("2023-06-01");
    });

    it("openai headers include Bearer token", () => {
      const headers = PROVIDER_ENDPOINTS.openai.headers("test-key");
      expect(headers.Authorization).toBe("Bearer test-key");
    });

    it("google headers include x-goog-api-key", () => {
      const headers = PROVIDER_ENDPOINTS.google.headers("test-key");
      expect(headers["x-goog-api-key"]).toBe("test-key");
    });

    it("discord headers include Bot prefix", () => {
      const headers = PROVIDER_ENDPOINTS.discord.headers("test-key");
      expect(headers.Authorization).toBe("Bot test-key");
    });
  });

  describe("validateProviderKey", () => {
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
      globalThis.fetch = vi.fn();
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it("returns valid=true when provider returns 200", async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(new Response(null, { status: 200 }));

      const result = await validateProviderKey("openai", "sk-valid-key");
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it("returns valid=false with error for 401", async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(new Response(null, { status: 401 }));

      const result = await validateProviderKey("anthropic", "sk-ant-invalid");
      expect(result.valid).toBe(false);
      expect(result.error).toBe("Invalid API key");
    });

    it("returns valid=false with error for 403", async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(new Response(null, { status: 403 }));

      const result = await validateProviderKey("discord", "bad-token");
      expect(result.valid).toBe(false);
      expect(result.error).toBe("Invalid API key");
    });

    it("returns valid=false with status for non-auth errors", async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(new Response(null, { status: 500 }));

      const result = await validateProviderKey("openai", "sk-key");
      expect(result.valid).toBe(false);
      expect(result.error).toBe("Provider returned status 500");
    });

    it("returns valid=false on network error", async () => {
      vi.mocked(globalThis.fetch).mockRejectedValue(new Error("Network timeout"));

      const result = await validateProviderKey("google", "AIza-key");
      expect(result.valid).toBe(false);
      expect(result.error).toBe("Network timeout");
    });

    it("calls the correct provider URL", async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(new Response(null, { status: 200 }));

      await validateProviderKey("anthropic", "sk-ant-test");
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "https://api.anthropic.com/v1/models",
        expect.objectContaining({
          method: "GET",
          headers: expect.objectContaining({ "x-api-key": "sk-ant-test" }),
        }),
      );
    });
  });
});
