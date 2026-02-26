import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RateStore } from "../../admin/rates/rate-store.js";
import type { DrizzleDb } from "../../db/index.js";
import { createTestDb, truncateAllTables } from "../../test/db.js";
import { DrizzleProviderHealthRepository } from "../drizzle-provider-health-repository.js";
import type { IProviderHealthRepository } from "../provider-health-repository.js";
import { ProviderRegistry } from "./provider-registry.js";

describe("ProviderRegistry", () => {
  let pool: PGlite;
  let db: DrizzleDb;
  let store: RateStore;
  let healthRepo: IProviderHealthRepository;

  beforeAll(async () => {
    ({ db, pool } = await createTestDb());
  });

  afterAll(async () => {
    await pool.close();
  });

  beforeEach(async () => {
    await truncateAllTables(pool);
    store = new RateStore(db);
    healthRepo = new DrizzleProviderHealthRepository(db);
  });

  function makeRegistry(cacheTtlMs = 30_000, unhealthyTtlMs = 60_000): ProviderRegistry {
    return new ProviderRegistry({ rateStore: store, healthRepo, cacheTtlMs, unhealthyTtlMs });
  }

  // ── Tier mapping ──

  it("maps known GPU adapters to gpu tier", async () => {
    await store.createProviderCost({
      capability: "tts",
      adapter: "chatterbox-tts",
      unit: "1K_chars",
      costUsd: 0.02,
      isActive: true,
    });
    const registry = makeRegistry();
    const providers = await registry.getProviders("tts");
    expect(providers).toHaveLength(1);
    expect(providers[0].tier).toBe("gpu");
  });

  it("maps self-hosted-* prefix adapters to gpu tier", async () => {
    await store.createProviderCost({
      capability: "text-generation",
      adapter: "self-hosted-llm",
      unit: "1M_tokens",
      costUsd: 0.001,
      isActive: true,
    });
    const registry = makeRegistry();
    const providers = await registry.getProviders("text-generation");
    expect(providers[0].tier).toBe("gpu");
  });

  it("maps third-party adapters to hosted tier", async () => {
    await store.createProviderCost({
      capability: "tts",
      adapter: "elevenlabs",
      unit: "1K_chars",
      costUsd: 0.15,
      isActive: true,
    });
    const registry = makeRegistry();
    const providers = await registry.getProviders("tts");
    expect(providers[0].tier).toBe("hosted");
  });

  // ── Cache behavior ──

  it("returns cached results within TTL", async () => {
    await store.createProviderCost({
      capability: "tts",
      adapter: "elevenlabs",
      unit: "1K_chars",
      costUsd: 0.15,
      isActive: true,
    });
    const registry = makeRegistry(30_000);
    const first = await registry.getProviders("tts");

    await store.createProviderCost({
      capability: "tts",
      adapter: "openai-tts",
      unit: "1K_chars",
      costUsd: 0.12,
      isActive: true,
    });

    const second = await registry.getProviders("tts");
    expect(second).toHaveLength(first.length);
  });

  it("refreshes after TTL expires", async () => {
    await store.createProviderCost({
      capability: "tts",
      adapter: "elevenlabs",
      unit: "1K_chars",
      costUsd: 0.15,
      isActive: true,
    });
    const registry = makeRegistry(1);
    await registry.getProviders("tts");

    await store.createProviderCost({
      capability: "tts",
      adapter: "openai-tts",
      unit: "1K_chars",
      costUsd: 0.12,
      isActive: true,
    });

    await new Promise((r) => setTimeout(r, 5));

    const providers = await registry.getProviders("tts");
    expect(providers.length).toBeGreaterThanOrEqual(2);
  });

  // ── Health overrides ──

  it("markUnhealthy causes provider to appear unhealthy", async () => {
    await store.createProviderCost({
      capability: "tts",
      adapter: "elevenlabs",
      unit: "1K_chars",
      costUsd: 0.15,
      isActive: true,
    });
    const registry = makeRegistry();
    await registry.getProviders("tts");
    registry.markUnhealthy("elevenlabs");

    const providers = await registry.getProviders("tts");
    expect(providers[0].healthy).toBe(false);
  });

  it("markHealthy after markUnhealthy restores healthy state", async () => {
    await store.createProviderCost({
      capability: "tts",
      adapter: "elevenlabs",
      unit: "1K_chars",
      costUsd: 0.15,
      isActive: true,
    });
    const registry = makeRegistry();
    await registry.getProviders("tts");
    registry.markUnhealthy("elevenlabs");
    registry.markHealthy("elevenlabs");

    const providers = await registry.getProviders("tts");
    expect(providers[0].healthy).toBe(true);
  });

  it("auto-recovers unhealthy provider after unhealthyTtlMs", async () => {
    await store.createProviderCost({
      capability: "tts",
      adapter: "elevenlabs",
      unit: "1K_chars",
      costUsd: 0.15,
      isActive: true,
    });
    const registry = makeRegistry(1, 1);
    registry.markUnhealthy("elevenlabs");

    await new Promise((r) => setTimeout(r, 5));

    const providers = await registry.getProviders("tts");
    expect(providers[0].healthy).toBe(true);
  });

  // ── Empty results ──

  it("returns empty array for nonexistent capability", async () => {
    const registry = makeRegistry();
    const providers = await registry.getProviders("nonexistent");
    expect(providers).toHaveLength(0);
  });

  // ── Disabled providers ──

  it("excludes providers with is_active = 0", async () => {
    await store.createProviderCost({
      capability: "tts",
      adapter: "elevenlabs",
      unit: "1K_chars",
      costUsd: 0.15,
      isActive: false,
    });
    const registry = makeRegistry();
    const providers = await registry.getProviders("tts");
    expect(providers).toHaveLength(0);
  });

  it("marks is_active = 1 providers as enabled", async () => {
    await store.createProviderCost({
      capability: "tts",
      adapter: "elevenlabs",
      unit: "1K_chars",
      costUsd: 0.15,
      isActive: true,
    });
    const registry = makeRegistry();
    const providers = await registry.getProviders("tts");
    expect(providers[0].enabled).toBe(true);
  });

  // ── Latency class mapping ──

  it("maps latency_class 'fast' to 'fast'", async () => {
    await store.createProviderCost({
      capability: "tts",
      adapter: "elevenlabs",
      unit: "1K_chars",
      costUsd: 0.15,
      latencyClass: "fast",
      isActive: true,
    });
    const registry = makeRegistry();
    const providers = await registry.getProviders("tts");
    expect(providers[0].latencyClass).toBe("fast");
  });

  it("maps latency_class 'standard' to 'normal'", async () => {
    await store.createProviderCost({
      capability: "tts",
      adapter: "elevenlabs",
      unit: "1K_chars",
      costUsd: 0.15,
      latencyClass: "standard",
      isActive: true,
    });
    const registry = makeRegistry();
    const providers = await registry.getProviders("tts");
    expect(providers[0].latencyClass).toBe("normal");
  });

  it("maps latency_class 'batch' to 'slow'", async () => {
    await store.createProviderCost({
      capability: "tts",
      adapter: "elevenlabs",
      unit: "1K_chars",
      costUsd: 0.15,
      latencyClass: "batch",
      isActive: true,
    });
    const registry = makeRegistry();
    const providers = await registry.getProviders("tts");
    expect(providers[0].latencyClass).toBe("slow");
  });

  // ── Sorting ──

  it("sorts GPU providers before hosted providers", async () => {
    await store.createProviderCost({
      capability: "tts",
      adapter: "elevenlabs",
      unit: "1K_chars",
      costUsd: 0.02,
      isActive: true,
    });
    await store.createProviderCost({
      capability: "tts",
      adapter: "chatterbox-tts",
      unit: "1K_chars",
      costUsd: 0.05,
      isActive: true,
    });

    const registry = makeRegistry();
    const providers = await registry.getProviders("tts");
    expect(providers[0].tier).toBe("gpu");
    expect(providers[1].tier).toBe("hosted");
  });
});
