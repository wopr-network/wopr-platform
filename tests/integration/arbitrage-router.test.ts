import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RateStore } from "../../src/admin/rates/rate-store.js";
import type { DrizzleDb } from "../../src/db/index.js";
import type {
  AdapterCapability,
  AdapterResult,
  ProviderAdapter,
  TTSInput,
  TTSOutput,
} from "../../src/monetization/adapters/types.js";
import { ArbitrageRouter } from "../../src/monetization/arbitrage/router.js";
import { ProviderRegistry } from "../../src/monetization/arbitrage/provider-registry.js";
import { NoProviderAvailableError } from "../../src/monetization/arbitrage/types.js";
import type { MarginRecord } from "../../src/monetization/arbitrage/types.js";
import { Credit } from "../../src/monetization/credit.js";
import { DrizzleProviderHealthRepository } from "../../src/monetization/drizzle-provider-health-repository.js";
import type { IProviderHealthRepository } from "../../src/monetization/provider-health-repository.js";
import {
  beginTestTransaction,
  createTestDb,
  endTestTransaction,
  rollbackTestTransaction,
} from "../../src/test/db.js";

// ── Stub Adapter ──

class StubTTSAdapter implements ProviderAdapter {
  readonly name: string;
  readonly capabilities: ReadonlyArray<AdapterCapability> = ["tts"];
  callCount = 0;

  private readonly _behavior: () => Promise<AdapterResult<TTSOutput>>;

  constructor(name: string, behavior: AdapterResult<TTSOutput> | Error) {
    this.name = name;
    if (behavior instanceof Error) {
      const err = behavior;
      this._behavior = () => Promise.reject(err);
    } else {
      const result = behavior;
      this._behavior = () => Promise.resolve(result);
    }
  }

  async synthesizeSpeech(_input: TTSInput): Promise<AdapterResult<TTSOutput>> {
    this.callCount++;
    return this._behavior();
  }
}

// ── Helpers ──

function makeOkResult(costDollars: number): AdapterResult<TTSOutput> {
  return {
    result: {
      audioUrl: "https://example.com/audio.mp3",
      durationSeconds: 1.5,
      format: "mp3",
      characterCount: 100,
    },
    cost: Credit.fromDollars(costDollars),
  };
}

function make5xxError(status = 500): Error {
  return Object.assign(new Error(`Server error ${status}`), { httpStatus: status });
}

// ── Tests ──

describe("ArbitrageRouter e2e", () => {
  let pool: PGlite;
  let db: DrizzleDb;
  let store: RateStore;
  let healthRepo: IProviderHealthRepository;

  beforeAll(async () => {
    ({ db, pool } = await createTestDb());
    await beginTestTransaction(pool);
  });

  afterAll(async () => {
    await endTestTransaction(pool);
    await pool.close();
  });

  beforeEach(async () => {
    await rollbackTestTransaction(pool);
    store = new RateStore(db);
    healthRepo = new DrizzleProviderHealthRepository(db);
  });

  function makeRegistry(): ProviderRegistry {
    return new ProviderRegistry({ rateStore: store, healthRepo, cacheTtlMs: 1, unhealthyTtlMs: 60_000 });
  }

  it("routes to cheapest provider (A@$0.01 over B@$0.02)", async () => {
    await store.createProviderCost({
      capability: "tts",
      adapter: "provider-a",
      unit: "1K_chars",
      costUsd: 0.01,
      isActive: true,
    });
    await store.createProviderCost({
      capability: "tts",
      adapter: "provider-b",
      unit: "1K_chars",
      costUsd: 0.02,
      isActive: true,
    });

    const adapterA = new StubTTSAdapter("provider-a", makeOkResult(0.01));
    const adapterB = new StubTTSAdapter("provider-b", makeOkResult(0.02));
    const adapters = new Map<string, ProviderAdapter>([
      ["provider-a", adapterA],
      ["provider-b", adapterB],
    ]);

    const registry = makeRegistry();
    const router = new ArbitrageRouter({ registry, adapters });

    const result = await router.route({
      capability: "tts",
      tenantId: "tenant-1",
      input: { text: "hello" },
    });

    expect(result.provider).toBe("provider-a");
    expect(adapterA.callCount).toBe(1);
    expect(adapterB.callCount).toBe(0);
  });

  it("fails over to B when A throws 5xx", async () => {
    await store.createProviderCost({
      capability: "tts",
      adapter: "provider-a",
      unit: "1K_chars",
      costUsd: 0.01,
      isActive: true,
    });
    await store.createProviderCost({
      capability: "tts",
      adapter: "provider-b",
      unit: "1K_chars",
      costUsd: 0.02,
      isActive: true,
    });

    const adapterA = new StubTTSAdapter("provider-a", make5xxError());
    const adapterB = new StubTTSAdapter("provider-b", makeOkResult(0.02));
    const adapters = new Map<string, ProviderAdapter>([
      ["provider-a", adapterA],
      ["provider-b", adapterB],
    ]);

    const registry = makeRegistry();
    const router = new ArbitrageRouter({ registry, adapters });

    const result = await router.route({
      capability: "tts",
      tenantId: "tenant-1",
      input: { text: "hello" },
    });

    expect(result.provider).toBe("provider-b");
    expect(adapterA.callCount).toBe(1);
    expect(adapterB.callCount).toBe(1);
  });

  it("throws NoProviderAvailableError when no providers exist", async () => {
    const registry = makeRegistry();
    const marginRecords: MarginRecord[] = [];
    const router = new ArbitrageRouter({
      registry,
      adapters: new Map(),
      onMarginRecord: (r) => marginRecords.push(r),
    });

    await expect(
      router.route({
        capability: "tts",
        tenantId: "tenant-1",
        input: { text: "hello" },
        sellPrice: 0.05,
      }),
    ).rejects.toBeInstanceOf(NoProviderAvailableError);

    expect(marginRecords).toHaveLength(0);
  });

  it("prefers GPU tier provider over cheaper hosted provider", async () => {
    await store.createProviderCost({
      capability: "tts",
      adapter: "self-hosted-tts",
      unit: "1K_chars",
      costUsd: 0.05,
      isActive: true,
    });
    await store.createProviderCost({
      capability: "tts",
      adapter: "elevenlabs",
      unit: "1K_chars",
      costUsd: 0.01,
      isActive: true,
    });

    const gpuAdapter = new StubTTSAdapter("self-hosted-tts", makeOkResult(0.05));
    const hostedAdapter = new StubTTSAdapter("elevenlabs", makeOkResult(0.01));
    const adapters = new Map<string, ProviderAdapter>([
      ["self-hosted-tts", gpuAdapter],
      ["elevenlabs", hostedAdapter],
    ]);

    const registry = makeRegistry();
    const router = new ArbitrageRouter({ registry, adapters });

    const result = await router.route({
      capability: "tts",
      tenantId: "tenant-1",
      input: { text: "hello" },
    });

    expect(result.provider).toBe("self-hosted-tts");
    expect(gpuAdapter.callCount).toBe(1);
    expect(hostedAdapter.callCount).toBe(0);
  });

  it("onMarginRecord fires with correct cost/revenue/margin", async () => {
    await store.createProviderCost({
      capability: "tts",
      adapter: "provider-a",
      unit: "1K_chars",
      costUsd: 0.01,
      isActive: true,
    });

    const adapterA = new StubTTSAdapter("provider-a", makeOkResult(0.008));
    const adapters = new Map<string, ProviderAdapter>([["provider-a", adapterA]]);

    const marginRecords: MarginRecord[] = [];
    const registry = makeRegistry();
    const router = new ArbitrageRouter({
      registry,
      adapters,
      onMarginRecord: (r) => marginRecords.push(r),
    });

    await router.route({
      capability: "tts",
      tenantId: "tenant-1",
      input: { text: "hello" },
      sellPrice: 0.02,
    });

    expect(marginRecords).toHaveLength(1);
    const record = marginRecords[0];
    expect(record.tenantId).toBe("tenant-1");
    expect(record.capability).toBe("tts");
    expect(record.adapter).toBe("provider-a");
    expect(record.providerCost).toBeCloseTo(0.008, 5);
    expect(record.sellPrice).toBe(0.02);
    expect(record.margin).toBeCloseTo(0.012, 5);
    // marginPct = (0.02 - 0.008) / 0.02 * 100 = 60%
    expect(record.marginPct).toBeCloseTo(60, 0);
    expect(record.timestamp).toBeGreaterThan(0);
  });
});
