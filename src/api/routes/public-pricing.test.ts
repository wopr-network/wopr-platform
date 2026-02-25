import type BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RateStore } from "../../admin/rates/rate-store.js";
import type { DrizzleDb } from "../../db/index.js";
import { createTestDb } from "../../test/db.js";

/**
 * Tests for the public-pricing route logic and RateStore.listPublicRates.
 *
 * The publicPricingRoutes Hono app uses a module-level singleton DB pointing
 * at /data/platform/rates.db (a filesystem path that won't exist in tests).
 * We test the grouping logic by exercising RateStore directly, which gives us
 * the branch coverage we need in rate-store.ts while keeping tests fast.
 */
describe("RateStore.listPublicRates (used by public pricing route)", () => {
  let db: DrizzleDb;
  let sqlite: BetterSqlite3.Database;
  let store: RateStore;

  beforeEach(() => {
    const t = createTestDb();
    db = t.db;
    sqlite = t.sqlite;
    store = new RateStore(db);
  });

  afterEach(() => {
    sqlite.close();
  });

  it("returns empty array when no rates exist", () => {
    const rates = store.listPublicRates();
    expect(rates).toEqual([]);
  });

  it("returns only active rates", () => {
    store.createSellRate({ capability: "tts", displayName: "TTS Standard", unit: "char", priceUsd: 0.001 });
    store.createSellRate({
      capability: "tts-hd",
      displayName: "TTS HD",
      unit: "char",
      priceUsd: 0.002,
      isActive: false,
    });

    const rates = store.listPublicRates();
    expect(rates).toHaveLength(1);
    expect(rates[0].display_name).toBe("TTS Standard");
  });

  it("orders by capability then sort_order", () => {
    store.createSellRate({ capability: "tts", displayName: "TTS B", unit: "char", priceUsd: 0.002, sortOrder: 2 });
    store.createSellRate({ capability: "llm", displayName: "LLM Fast", unit: "token", priceUsd: 0.001, sortOrder: 1 });
    store.createSellRate({
      capability: "tts",
      displayName: "TTS A",
      unit: "char",
      priceUsd: 0.001,
      model: "tts-a",
      sortOrder: 1,
    });

    const rates = store.listPublicRates();
    expect(rates[0].capability).toBe("llm");
    expect(rates[1].display_name).toBe("TTS A");
    expect(rates[2].display_name).toBe("TTS B");
  });

  it("grouping logic works for multiple capabilities", () => {
    store.createSellRate({ capability: "tts", displayName: "TTS Standard", unit: "char", priceUsd: 0.001 });
    store.createSellRate({ capability: "llm", displayName: "GPT Fast", unit: "token", priceUsd: 0.0001 });
    store.createSellRate({
      capability: "tts",
      displayName: "TTS HD",
      unit: "char",
      priceUsd: 0.002,
      model: "tts-hd",
    });

    const rates = store.listPublicRates();

    const grouped: Record<string, Array<{ name: string; unit: string; price: number }>> = {};
    for (const rate of rates) {
      if (!grouped[rate.capability]) grouped[rate.capability] = [];
      grouped[rate.capability].push({ name: rate.display_name, unit: rate.unit, price: rate.price_usd });
    }

    expect(Object.keys(grouped)).toContain("tts");
    expect(Object.keys(grouped)).toContain("llm");
    expect(grouped.tts).toHaveLength(2);
    expect(grouped.llm).toHaveLength(1);
  });
});

describe("publicPricingRoutes Hono app", () => {
  it("returns 500 with error JSON when DB is unavailable", async () => {
    // Force the route to use a guaranteed non-existent DB path so the error
    // branch is always exercised, regardless of host filesystem state.
    vi.resetModules();
    process.env.RATES_DB_PATH = "/nonexistent/path/rates.db";
    try {
      const { publicPricingRoutes } = await import("./public-pricing.js");
      const res = await publicPricingRoutes.request("/");
      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: string };
      expect(body).toHaveProperty("error");
    } finally {
      delete process.env.RATES_DB_PATH;
      vi.resetModules();
    }
  });
});
