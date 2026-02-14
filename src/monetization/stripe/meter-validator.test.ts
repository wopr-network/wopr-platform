import type Stripe from "stripe";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MeterEventNameMap } from "../metering/usage-aggregation-worker.js";
import { validateStripeMeters } from "./meter-validator.js";

// Mock logger to avoid console noise in tests
vi.mock("../../config/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe("validateStripeMeters", () => {
  // Mock Stripe client
  const createMockStripe = (meterEventNames: string[]): Stripe => {
    const meters = meterEventNames.map((event_name) => ({
      id: `meter_${event_name}`,
      event_name,
      created: Date.now(),
      livemode: false,
      object: "billing.meter" as const,
      customer_mapping: { type: "by_id" as const, event_payload_key: "stripe_customer_id" },
      default_aggregation: { formula: "sum" as const },
      display_name: event_name,
      status: "active" as const,
      status_transitions: { deactivated_at: null },
      updated: Date.now(),
      value_settings: { event_payload_key: "value" },
    }));

    return {
      billing: {
        meters: {
          list: vi.fn().mockResolvedValue({ data: meters }),
        },
      },
    } as unknown as Stripe;
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("warn mode (default)", () => {
    it("should pass validation when all meters exist", async () => {
      const meterEventNames: MeterEventNameMap = {
        chat: "wopr_chat_usage",
        stt: "wopr_stt_usage",
        embeddings: "wopr_embeddings_usage",
      };

      const stripe = createMockStripe(["wopr_chat_usage", "wopr_stt_usage", "wopr_embeddings_usage"]);

      const result = await validateStripeMeters(stripe, meterEventNames);

      expect(result.valid).toBe(true);
      expect(result.found).toEqual(["chat", "stt", "embeddings"]);
      expect(result.missing).toEqual([]);
      expect(result.criticalMissing).toEqual([]);
    });

    it("should warn but not throw when non-critical meters are missing", async () => {
      const meterEventNames: MeterEventNameMap = {
        chat: "wopr_chat_usage",
        embeddings: "wopr_embeddings_usage", // missing
      };

      const stripe = createMockStripe(["wopr_chat_usage"]);

      const result = await validateStripeMeters(stripe, meterEventNames);

      expect(result.valid).toBe(false);
      expect(result.found).toEqual(["chat"]);
      expect(result.missing).toEqual(["embeddings"]);
      expect(result.criticalMissing).toEqual([]); // embeddings is not critical
    });

    it("should warn but not throw when critical meters are missing in warn mode", async () => {
      const meterEventNames: MeterEventNameMap = {
        chat: "wopr_chat_usage", // critical but missing
        embeddings: "wopr_embeddings_usage",
      };

      const stripe = createMockStripe(["wopr_embeddings_usage"]);

      const result = await validateStripeMeters(stripe, meterEventNames, { mode: "warn" });

      expect(result.valid).toBe(false);
      expect(result.found).toEqual(["embeddings"]);
      expect(result.missing).toEqual(["chat"]);
      expect(result.criticalMissing).toEqual(["chat"]);
    });

    it("should handle empty meter configuration", async () => {
      const stripe = createMockStripe([]);
      const result = await validateStripeMeters(stripe, {});

      expect(result.valid).toBe(true);
      expect(result.found).toEqual([]);
      expect(result.missing).toEqual([]);
    });
  });

  describe("strict mode", () => {
    it("should throw when critical meters are missing", async () => {
      const meterEventNames: MeterEventNameMap = {
        chat: "wopr_chat_usage", // critical
        embeddings: "wopr_embeddings_usage",
      };

      const stripe = createMockStripe(["wopr_embeddings_usage"]);

      await expect(validateStripeMeters(stripe, meterEventNames, { mode: "strict" })).rejects.toThrow(
        /Stripe Meter validation failed in strict mode/,
      );
    });

    it("should pass when all critical meters exist", async () => {
      const meterEventNames: MeterEventNameMap = {
        chat: "wopr_chat_usage",
        stt: "wopr_stt_usage",
        embeddings: "wopr_embeddings_usage",
      };

      const stripe = createMockStripe(["wopr_chat_usage", "wopr_stt_usage", "wopr_embeddings_usage"]);

      const result = await validateStripeMeters(stripe, meterEventNames, { mode: "strict" });

      expect(result.valid).toBe(true);
      expect(result.found).toEqual(["chat", "stt", "embeddings"]);
    });

    it("should not throw when only non-critical meters are missing", async () => {
      const meterEventNames: MeterEventNameMap = {
        chat: "wopr_chat_usage",
        stt: "wopr_stt_usage",
        embeddings: "wopr_embeddings_usage", // non-critical, missing
      };

      const stripe = createMockStripe(["wopr_chat_usage", "wopr_stt_usage"]);

      const result = await validateStripeMeters(stripe, meterEventNames, { mode: "strict" });

      expect(result.valid).toBe(false);
      expect(result.missing).toEqual(["embeddings"]);
      expect(result.criticalMissing).toEqual([]);
    });
  });

  describe("custom critical capabilities", () => {
    it("should respect custom critical capabilities set", async () => {
      const meterEventNames: MeterEventNameMap = {
        embeddings: "wopr_embeddings_usage",
        search: "wopr_search_usage",
      };

      const stripe = createMockStripe(["wopr_search_usage"]);

      // Make embeddings critical
      const criticalCapabilities = new Set(["embeddings"]);

      await expect(
        validateStripeMeters(stripe, meterEventNames, { mode: "strict", criticalCapabilities }),
      ).rejects.toThrow(/Stripe Meter validation failed/);
    });

    it("should pass with custom critical capabilities when all exist", async () => {
      const meterEventNames: MeterEventNameMap = {
        embeddings: "wopr_embeddings_usage",
        search: "wopr_search_usage",
      };

      const stripe = createMockStripe(["wopr_embeddings_usage", "wopr_search_usage"]);

      const criticalCapabilities = new Set(["embeddings", "search"]);

      const result = await validateStripeMeters(stripe, meterEventNames, {
        mode: "strict",
        criticalCapabilities,
      });

      expect(result.valid).toBe(true);
    });
  });

  describe("error handling", () => {
    it("should throw when Stripe API fails", async () => {
      const stripe = {
        billing: {
          meters: {
            list: vi.fn().mockRejectedValue(new Error("Stripe API down")),
          },
        },
      } as unknown as Stripe;

      const meterEventNames: MeterEventNameMap = {
        chat: "wopr_chat_usage",
      };

      await expect(validateStripeMeters(stripe, meterEventNames)).rejects.toThrow(/Failed to list Stripe Meters/);
    });

    it("should handle non-Error exceptions from Stripe", async () => {
      const stripe = {
        billing: {
          meters: {
            list: vi.fn().mockRejectedValue("unknown error"),
          },
        },
      } as unknown as Stripe;

      const meterEventNames: MeterEventNameMap = {
        chat: "wopr_chat_usage",
      };

      await expect(validateStripeMeters(stripe, meterEventNames)).rejects.toThrow(/Failed to list Stripe Meters/);
    });
  });

  describe("comprehensive scenario", () => {
    it("should correctly identify mix of found, missing, and critical meters", async () => {
      const meterEventNames: MeterEventNameMap = {
        chat: "wopr_chat_usage", // critical, exists
        stt: "wopr_stt_usage", // critical, missing
        embeddings: "wopr_embeddings_usage", // non-critical, exists
        search: "wopr_search_usage", // non-critical, missing
        tts: "wopr_tts_usage", // non-critical, exists
      };

      const stripe = createMockStripe(["wopr_chat_usage", "wopr_embeddings_usage", "wopr_tts_usage"]);

      const result = await validateStripeMeters(stripe, meterEventNames, { mode: "warn" });

      expect(result.valid).toBe(false);
      expect(result.found).toEqual(["chat", "embeddings", "tts"]);
      expect(result.missing).toEqual(["stt", "search"]);
      expect(result.criticalMissing).toEqual(["stt"]);
    });
  });

  describe("edge cases", () => {
    it("should handle Stripe returning more meters than configured", async () => {
      const meterEventNames: MeterEventNameMap = {
        chat: "wopr_chat_usage",
      };

      const stripe = createMockStripe(["wopr_chat_usage", "wopr_extra_usage", "wopr_another_usage"]);

      const result = await validateStripeMeters(stripe, meterEventNames);

      expect(result.valid).toBe(true);
      expect(result.found).toEqual(["chat"]);
    });

    it("should handle duplicate event names in configuration", async () => {
      const meterEventNames: MeterEventNameMap = {
        chat: "wopr_chat_usage",
        voice: "wopr_chat_usage", // same event name
      };

      const stripe = createMockStripe(["wopr_chat_usage"]);

      const result = await validateStripeMeters(stripe, meterEventNames);

      expect(result.valid).toBe(true);
      expect(result.found).toEqual(["chat", "voice"]);
    });
  });
});
