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
import { Credit } from "@wopr-network/platform-core";
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

// ── Shared adapter key constants ──

const PROVIDER_A = "provider-a";
const PROVIDER_B = "provider-b";
const SELF_HOSTED_TTS = "self-hosted-tts";
const ELEVENLABS = "elevenlabs";

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

function createProviderCostParams(adapter: string, costUsd: number) {
  return { capability: "tts", adapter, unit: "1K_chars", costUsd, isActive: true };
}

function makeAdapters(...pairs: [string, StubTTSAdapter][]): Map<string, ProviderAdapter> {
  return new Map<string, ProviderAdapter>(pairs);
}

// ── Tests ──

describe("ArbitrageRouter e2e", () => {
  let pool: PGlite;
  let db: DrizzleDb;
  let store: RateStore;
  let healthRepo: IProviderHealthRepository;
  let tenantId: string;

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
    tenantId = crypto.randomUUID();
  });

  function makeRegistry(): ProviderRegistry {
    return new ProviderRegistry({ rateStore: store, healthRepo, cacheTtlMs: 0, unhealthyTtlMs: 60_000 });
  }

  it("routes to cheapest provider (A@$0.01 over B@$0.02)", async () => {
    await store.createProviderCost(createProviderCostParams(PROVIDER_A, 0.01));
    await store.createProviderCost(createProviderCostParams(PROVIDER_B, 0.02));

    const adapterA = new StubTTSAdapter(PROVIDER_A, makeOkResult(0.01));
    const adapterB = new StubTTSAdapter(PROVIDER_B, makeOkResult(0.02));
    const adapters = makeAdapters([PROVIDER_A, adapterA], [PROVIDER_B, adapterB]);

    const registry = makeRegistry();
    const router = new ArbitrageRouter({ registry, adapters });

    const result = await router.route({
      capability: "tts",
      tenantId,
      input: { text: "hello" },
    });

    expect(result.provider).toBe(PROVIDER_A);
    expect(adapterA.callCount).toBe(1);
    expect(adapterB.callCount).toBe(0);
  });

  it("fails over to B when A throws 5xx", async () => {
    await store.createProviderCost(createProviderCostParams(PROVIDER_A, 0.01));
    await store.createProviderCost(createProviderCostParams(PROVIDER_B, 0.02));

    const adapterA = new StubTTSAdapter(PROVIDER_A, make5xxError());
    const adapterB = new StubTTSAdapter(PROVIDER_B, makeOkResult(0.02));
    const adapters = makeAdapters([PROVIDER_A, adapterA], [PROVIDER_B, adapterB]);

    const registry = makeRegistry();
    const router = new ArbitrageRouter({ registry, adapters });

    const result = await router.route({
      capability: "tts",
      tenantId,
      input: { text: "hello" },
    });

    expect(result.provider).toBe(PROVIDER_B);
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
        tenantId,
        input: { text: "hello" },
        sellPrice: Credit.fromDollars(0.05),
      }),
    ).rejects.toBeInstanceOf(NoProviderAvailableError);

    expect(marginRecords).toHaveLength(0);
  });

  it("throws NoProviderAvailableError when all providers are unhealthy", async () => {
    await store.createProviderCost(createProviderCostParams(PROVIDER_A, 0.01));
    await store.createProviderCost(createProviderCostParams(PROVIDER_B, 0.02));
    await healthRepo.markUnhealthy(PROVIDER_A);
    await healthRepo.markUnhealthy(PROVIDER_B);

    const adapterA = new StubTTSAdapter(PROVIDER_A, makeOkResult(0.01));
    const adapterB = new StubTTSAdapter(PROVIDER_B, makeOkResult(0.02));
    const adapters = makeAdapters([PROVIDER_A, adapterA], [PROVIDER_B, adapterB]);

    const registry = makeRegistry();
    const router = new ArbitrageRouter({ registry, adapters });

    await expect(
      router.route({ capability: "tts", tenantId, input: { text: "hello" } }),
    ).rejects.toBeInstanceOf(NoProviderAvailableError);

    expect(adapterA.callCount).toBe(0);
    expect(adapterB.callCount).toBe(0);
  });

  it("prefers GPU tier provider over cheaper hosted provider", async () => {
    await store.createProviderCost(createProviderCostParams(SELF_HOSTED_TTS, 0.05));
    await store.createProviderCost(createProviderCostParams(ELEVENLABS, 0.01));

    const gpuAdapter = new StubTTSAdapter(SELF_HOSTED_TTS, makeOkResult(0.05));
    const hostedAdapter = new StubTTSAdapter(ELEVENLABS, makeOkResult(0.01));
    const adapters = makeAdapters([SELF_HOSTED_TTS, gpuAdapter], [ELEVENLABS, hostedAdapter]);

    const registry = makeRegistry();
    const router = new ArbitrageRouter({ registry, adapters });

    const result = await router.route({
      capability: "tts",
      tenantId,
      input: { text: "hello" },
    });

    expect(result.provider).toBe(SELF_HOSTED_TTS);
    expect(gpuAdapter.callCount).toBe(1);
    expect(hostedAdapter.callCount).toBe(0);
  });

  it("onMarginRecord fires with correct cost/revenue/margin", async () => {
    await store.createProviderCost(createProviderCostParams(PROVIDER_A, 0.01));

    const adapterA = new StubTTSAdapter(PROVIDER_A, makeOkResult(0.008));
    const adapters = makeAdapters([PROVIDER_A, adapterA]);

    const marginRecords: MarginRecord[] = [];
    const registry = makeRegistry();
    const router = new ArbitrageRouter({
      registry,
      adapters,
      onMarginRecord: (r) => marginRecords.push(r),
    });

    await router.route({
      capability: "tts",
      tenantId,
      input: { text: "hello" },
      sellPrice: Credit.fromDollars(0.02),
    });

    expect(marginRecords).toHaveLength(1);
    const record = marginRecords[0];
    expect(record.tenantId).toBe(tenantId);
    expect(record.capability).toBe("tts");
    expect(record.adapter).toBe(PROVIDER_A);
    expect(record.providerCost.toDollars()).toBeCloseTo(0.008, 5);
    expect(record.sellPrice.toDollars()).toBe(0.02);
    expect(record.margin.toDollars()).toBeCloseTo(0.012, 5);
    // marginPct = (0.02 - 0.008) / 0.02 * 100 = 60%
    expect(record.marginPct).toBeCloseTo(60, 0);
    expect(record.timestamp).toBeGreaterThan(0);
  });
});
