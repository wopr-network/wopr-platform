import BetterSqlite3 from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RateStore } from "../../admin/rates/rate-store.js";
import type { DrizzleDb } from "../../db/index.js";
import * as schema from "../../db/schema/index.js";
import { createTestDb as createMigratedTestDb } from "../../test/db.js";
import { DrizzleProviderHealthRepository } from "../drizzle-provider-health-repository.js";
import type { IProviderHealthRepository } from "../provider-health-repository.js";
import { ProviderRegistry } from "./provider-registry.js";

function createTestHealthRepo(): IProviderHealthRepository {
  const sqlite = new BetterSqlite3(":memory:");
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS provider_health_overrides (
      adapter TEXT PRIMARY KEY,
      healthy INTEGER NOT NULL DEFAULT 1,
      marked_at INTEGER NOT NULL
    );
  `);
  return new DrizzleProviderHealthRepository(drizzle(sqlite, { schema }));
}

describe("ProviderRegistry", () => {
  let db: DrizzleDb;
  let sqlite: BetterSqlite3.Database;
  let store: RateStore;

  beforeEach(() => {
    const t = createMigratedTestDb();
    db = t.db;
    sqlite = t.sqlite;
    store = new RateStore(db);
  });

  afterEach(() => {
    sqlite.close();
  });

  function makeRegistry(cacheTtlMs = 30_000, unhealthyTtlMs = 60_000): ProviderRegistry {
    return new ProviderRegistry({ rateStore: store, healthRepo: createTestHealthRepo(), cacheTtlMs, unhealthyTtlMs });
  }

  // ── Tier mapping ──

  it("maps known GPU adapters to gpu tier", () => {
    store.createProviderCost({
      capability: "tts",
      adapter: "chatterbox-tts",
      unit: "1K_chars",
      costUsd: 0.02,
      isActive: true,
    });

    const registry = makeRegistry();
    const providers = registry.getProviders("tts");
    expect(providers).toHaveLength(1);
    expect(providers[0].tier).toBe("gpu");
  });

  it("maps self-hosted-* prefix adapters to gpu tier", () => {
    store.createProviderCost({
      capability: "text-generation",
      adapter: "self-hosted-llm",
      unit: "1M_tokens",
      costUsd: 0.001,
      isActive: true,
    });

    const registry = makeRegistry();
    const providers = registry.getProviders("text-generation");
    expect(providers[0].tier).toBe("gpu");
  });

  it("maps third-party adapters to hosted tier", () => {
    store.createProviderCost({
      capability: "tts",
      adapter: "elevenlabs",
      unit: "1K_chars",
      costUsd: 0.15,
      isActive: true,
    });

    const registry = makeRegistry();
    const providers = registry.getProviders("tts");
    expect(providers[0].tier).toBe("hosted");
  });

  // ── Cache behavior ──

  it("returns cached results within TTL", () => {
    store.createProviderCost({
      capability: "tts",
      adapter: "elevenlabs",
      unit: "1K_chars",
      costUsd: 0.15,
      isActive: true,
    });

    const registry = makeRegistry(30_000);
    const first = registry.getProviders("tts");

    // Add another provider to DB — should not appear in cached result
    store.createProviderCost({
      capability: "tts",
      adapter: "openai-tts",
      unit: "1K_chars",
      costUsd: 0.12,
      isActive: true,
    });

    const second = registry.getProviders("tts");
    // Should still return cached 1-entry result
    expect(second).toHaveLength(first.length);
  });

  it("refreshes after TTL expires", async () => {
    store.createProviderCost({
      capability: "tts",
      adapter: "elevenlabs",
      unit: "1K_chars",
      costUsd: 0.15,
      isActive: true,
    });

    // Very short TTL (1ms)
    const registry = makeRegistry(1);
    registry.getProviders("tts");

    // Add another provider
    store.createProviderCost({
      capability: "tts",
      adapter: "openai-tts",
      unit: "1K_chars",
      costUsd: 0.12,
      isActive: true,
    });

    // Wait for TTL to expire
    await new Promise((r) => setTimeout(r, 5));

    const providers = registry.getProviders("tts");
    expect(providers.length).toBeGreaterThanOrEqual(2);
  });

  // ── Health overrides ──

  it("markUnhealthy causes provider to appear unhealthy", () => {
    store.createProviderCost({
      capability: "tts",
      adapter: "elevenlabs",
      unit: "1K_chars",
      costUsd: 0.15,
      isActive: true,
    });

    const registry = makeRegistry();
    registry.getProviders("tts"); // populate cache
    registry.markUnhealthy("elevenlabs");

    const providers = registry.getProviders("tts");
    expect(providers[0].healthy).toBe(false);
  });

  it("markHealthy after markUnhealthy restores healthy state", () => {
    store.createProviderCost({
      capability: "tts",
      adapter: "elevenlabs",
      unit: "1K_chars",
      costUsd: 0.15,
      isActive: true,
    });

    const registry = makeRegistry();
    registry.getProviders("tts");
    registry.markUnhealthy("elevenlabs");
    registry.markHealthy("elevenlabs");

    const providers = registry.getProviders("tts");
    expect(providers[0].healthy).toBe(true);
  });

  it("auto-recovers unhealthy provider after unhealthyTtlMs", async () => {
    store.createProviderCost({
      capability: "tts",
      adapter: "elevenlabs",
      unit: "1K_chars",
      costUsd: 0.15,
      isActive: true,
    });

    // Short unhealthy TTL (1ms), short cache TTL to avoid stale cache issue
    const registry = makeRegistry(1, 1);
    registry.markUnhealthy("elevenlabs");

    // Wait for unhealthy TTL to expire
    await new Promise((r) => setTimeout(r, 5));

    const providers = registry.getProviders("tts");
    expect(providers[0].healthy).toBe(true);
  });

  // ── Empty results ──

  it("returns empty array for nonexistent capability", () => {
    const registry = makeRegistry();
    const providers = registry.getProviders("nonexistent");
    expect(providers).toHaveLength(0);
  });

  // ── Disabled providers ──

  it("excludes providers with is_active = 0", () => {
    store.createProviderCost({
      capability: "tts",
      adapter: "elevenlabs",
      unit: "1K_chars",
      costUsd: 0.15,
      isActive: false,
    });

    const registry = makeRegistry();
    const providers = registry.getProviders("tts");
    expect(providers).toHaveLength(0);
  });

  it("marks is_active = 1 providers as enabled", () => {
    store.createProviderCost({
      capability: "tts",
      adapter: "elevenlabs",
      unit: "1K_chars",
      costUsd: 0.15,
      isActive: true,
    });

    const registry = makeRegistry();
    const providers = registry.getProviders("tts");
    expect(providers[0].enabled).toBe(true);
  });

  // ── Latency class mapping ──

  it("maps latency_class 'fast' to 'fast'", () => {
    store.createProviderCost({
      capability: "tts",
      adapter: "elevenlabs",
      unit: "1K_chars",
      costUsd: 0.15,
      latencyClass: "fast",
      isActive: true,
    });

    const registry = makeRegistry();
    const providers = registry.getProviders("tts");
    expect(providers[0].latencyClass).toBe("fast");
  });

  it("maps latency_class 'standard' to 'normal'", () => {
    store.createProviderCost({
      capability: "tts",
      adapter: "elevenlabs",
      unit: "1K_chars",
      costUsd: 0.15,
      latencyClass: "standard",
      isActive: true,
    });

    const registry = makeRegistry();
    const providers = registry.getProviders("tts");
    expect(providers[0].latencyClass).toBe("normal");
  });

  it("maps latency_class 'batch' to 'slow'", () => {
    store.createProviderCost({
      capability: "tts",
      adapter: "elevenlabs",
      unit: "1K_chars",
      costUsd: 0.15,
      latencyClass: "batch",
      isActive: true,
    });

    const registry = makeRegistry();
    const providers = registry.getProviders("tts");
    expect(providers[0].latencyClass).toBe("slow");
  });

  // ── Sorting ──

  it("sorts GPU providers before hosted providers", () => {
    store.createProviderCost({
      capability: "tts",
      adapter: "elevenlabs",
      unit: "1K_chars",
      costUsd: 0.02, // cheaper but hosted
      isActive: true,
    });
    store.createProviderCost({
      capability: "tts",
      adapter: "chatterbox-tts",
      unit: "1K_chars",
      costUsd: 0.05, // more expensive but GPU
      isActive: true,
    });

    const registry = makeRegistry();
    const providers = registry.getProviders("tts");
    expect(providers[0].tier).toBe("gpu");
    expect(providers[1].tier).toBe("hosted");
  });
});
