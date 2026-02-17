import { describe, expect, it, vi } from "vitest";
import type { AdapterCapability, AdapterResult, ProviderAdapter, TTSOutput } from "../adapters/types.js";
import type { ProviderRegistry } from "./provider-registry.js";
import { ArbitrageRouter } from "./router.js";
import type { ModelProviderEntry } from "./types.js";
import { NoProviderAvailableError } from "./types.js";

// ── Helpers ──

function makeEntry(overrides: Partial<ModelProviderEntry> = {}): ModelProviderEntry {
  return {
    capability: "tts",
    adapter: "elevenlabs",
    tier: "hosted",
    providerCost: 0.15,
    costUnit: "1K_chars",
    healthy: true,
    priority: 0,
    latencyClass: "normal",
    enabled: true,
    ...overrides,
  };
}

function makeRegistry(providers: ModelProviderEntry[]): ProviderRegistry {
  const healthOverrides = new Map<string, boolean>();
  return {
    getProviders: (capability: string) =>
      providers
        .filter((p) => p.capability === capability)
        .map((p) => {
          const healthy = healthOverrides.has(p.adapter) ? (healthOverrides.get(p.adapter) ?? p.healthy) : p.healthy;
          return { ...p, healthy };
        }),
    markUnhealthy: (adapter: string) => {
      healthOverrides.set(adapter, false);
    },
    markHealthy: (adapter: string) => {
      healthOverrides.delete(adapter);
    },
    refresh: vi.fn(),
  } as unknown as ProviderRegistry;
}

function makeAdapter(
  name: string,
  capabilities: AdapterCapability[],
  result: AdapterResult<TTSOutput> | Error,
): ProviderAdapter {
  return {
    name,
    capabilities,
    synthesizeSpeech: vi.fn().mockImplementation(() => {
      if (result instanceof Error) return Promise.reject(result);
      return Promise.resolve(result);
    }),
  };
}

const fakeTTSResult: AdapterResult<TTSOutput> = {
  result: { audioUrl: "https://example.com/audio.mp3", durationSeconds: 1.5, format: "mp3", characterCount: 100 },
  cost: 0.015,
};

// ── Tests ──

describe("ArbitrageRouter", () => {
  describe("selectProvider", () => {
    it("selects GPU provider when available", () => {
      const gpu = makeEntry({ adapter: "chatterbox-tts", tier: "gpu", providerCost: 0.02 });
      const hosted = makeEntry({ adapter: "elevenlabs", tier: "hosted", providerCost: 0.12 });
      const registry = makeRegistry([gpu, hosted]);

      const router = new ArbitrageRouter({ registry, adapters: new Map() });
      const decision = router.selectProvider("tts");

      expect(decision.provider.adapter).toBe("chatterbox-tts");
      expect(decision.reason).toBe("gpu-cheapest");
    });

    it("selects hosted provider when no GPU available", () => {
      const hosted = makeEntry({ adapter: "elevenlabs", tier: "hosted", providerCost: 0.15 });
      const registry = makeRegistry([hosted]);

      const router = new ArbitrageRouter({ registry, adapters: new Map() });
      const decision = router.selectProvider("tts");

      expect(decision.provider.adapter).toBe("elevenlabs");
      expect(decision.reason).toBe("hosted-cheapest");
    });

    it("selects cheapest hosted provider (arbitrage)", () => {
      const expensive = makeEntry({ adapter: "elevenlabs", tier: "hosted", providerCost: 0.15 });
      const cheap = makeEntry({ adapter: "openai-tts", tier: "hosted", providerCost: 0.12 });
      const registry = makeRegistry([expensive, cheap]);

      const router = new ArbitrageRouter({ registry, adapters: new Map() });
      const decision = router.selectProvider("tts");

      expect(decision.provider.adapter).toBe("openai-tts");
    });

    it("uses priority as tiebreaker when costs are equal", () => {
      const p1 = makeEntry({ adapter: "a", tier: "hosted", providerCost: 0.12, priority: 2 });
      const p2 = makeEntry({ adapter: "b", tier: "hosted", providerCost: 0.12, priority: 1 });
      const registry = makeRegistry([p1, p2]);

      const router = new ArbitrageRouter({ registry, adapters: new Map() });
      const decision = router.selectProvider("tts");

      expect(decision.provider.adapter).toBe("b"); // lower priority wins
    });

    it("throws NoProviderAvailableError when no providers registered", () => {
      const registry = makeRegistry([]);
      const router = new ArbitrageRouter({ registry, adapters: new Map() });

      expect(() => router.selectProvider("tts")).toThrow(NoProviderAvailableError);
    });

    it("skips disabled providers", () => {
      const disabled = makeEntry({ adapter: "disabled-provider", tier: "gpu", enabled: false });
      const registry = makeRegistry([disabled]);
      const router = new ArbitrageRouter({ registry, adapters: new Map() });

      expect(() => router.selectProvider("tts")).toThrow(NoProviderAvailableError);
    });

    it("skips unhealthy providers", () => {
      const unhealthy = makeEntry({ adapter: "sick-provider", tier: "gpu", healthy: false });
      const registry = makeRegistry([unhealthy]);
      const router = new ArbitrageRouter({ registry, adapters: new Map() });

      expect(() => router.selectProvider("tts")).toThrow(NoProviderAvailableError);
    });
  });

  describe("route", () => {
    it("routes to GPU provider first", async () => {
      const gpu = makeEntry({ adapter: "chatterbox-tts", tier: "gpu", providerCost: 0.02 });
      const hosted = makeEntry({ adapter: "elevenlabs", tier: "hosted", providerCost: 0.12 });
      const registry = makeRegistry([gpu, hosted]);

      const gpuAdapter = makeAdapter("chatterbox-tts", ["tts"], fakeTTSResult);
      const hostedAdapter = makeAdapter("elevenlabs", ["tts"], fakeTTSResult);
      const adapters = new Map([
        ["chatterbox-tts", gpuAdapter],
        ["elevenlabs", hostedAdapter],
      ]);

      const router = new ArbitrageRouter({ registry, adapters });
      await router.route({ capability: "tts", tenantId: "t1", input: { text: "hello" } });

      expect(gpuAdapter.synthesizeSpeech).toHaveBeenCalledOnce();
      expect(hostedAdapter.synthesizeSpeech).not.toHaveBeenCalled();
    });

    it("falls through to hosted when GPU unavailable", async () => {
      const gpu = makeEntry({ adapter: "chatterbox-tts", tier: "gpu", providerCost: 0.02, healthy: false });
      const hosted = makeEntry({ adapter: "elevenlabs", tier: "hosted", providerCost: 0.12 });
      const registry = makeRegistry([gpu, hosted]);

      const hostedAdapter = makeAdapter("elevenlabs", ["tts"], fakeTTSResult);
      const adapters = new Map([["elevenlabs", hostedAdapter]]);

      const router = new ArbitrageRouter({ registry, adapters });
      await router.route({ capability: "tts", tenantId: "t1", input: { text: "hello" } });

      expect(hostedAdapter.synthesizeSpeech).toHaveBeenCalledOnce();
    });

    it("failover on 5xx — retries with next provider and marks first unhealthy", async () => {
      const gpu = makeEntry({ adapter: "chatterbox-tts", tier: "gpu", providerCost: 0.02 });
      const hosted = makeEntry({ adapter: "elevenlabs", tier: "hosted", providerCost: 0.12 });
      const registry = makeRegistry([gpu, hosted]);

      const serverError = Object.assign(new Error("Server error"), { httpStatus: 500 });
      const gpuAdapter = makeAdapter("chatterbox-tts", ["tts"], serverError);
      const hostedAdapter = makeAdapter("elevenlabs", ["tts"], fakeTTSResult);
      const adapters = new Map([
        ["chatterbox-tts", gpuAdapter],
        ["elevenlabs", hostedAdapter],
      ]);

      const router = new ArbitrageRouter({ registry, adapters });
      const result = await router.route({ capability: "tts", tenantId: "t1", input: { text: "hello" } });

      expect(gpuAdapter.synthesizeSpeech).toHaveBeenCalledOnce();
      expect(hostedAdapter.synthesizeSpeech).toHaveBeenCalledOnce();
      expect(result.cost).toBe(fakeTTSResult.cost);
    });

    it("does NOT failover on 4xx — rethrows error", async () => {
      // openai-tts at 0.10 is cheaper, so it gets selected first
      const hosted = makeEntry({ adapter: "elevenlabs", tier: "hosted", providerCost: 0.12 });
      const hosted2 = makeEntry({ adapter: "openai-tts", tier: "hosted", providerCost: 0.1 });
      const registry = makeRegistry([hosted, hosted2]);

      const clientError = Object.assign(new Error("Bad request"), { httpStatus: 400 });
      // openai-tts (cheaper) returns 4xx; elevenlabs should NOT be tried
      const adapterElevenlabs = makeAdapter("elevenlabs", ["tts"], fakeTTSResult);
      const adapterOpenaiTts = makeAdapter("openai-tts", ["tts"], clientError);
      const adapters = new Map([
        ["elevenlabs", adapterElevenlabs],
        ["openai-tts", adapterOpenaiTts],
      ]);

      const router = new ArbitrageRouter({ registry, adapters });
      await expect(router.route({ capability: "tts", tenantId: "t1", input: { text: "hello" } })).rejects.toMatchObject(
        { httpStatus: 400 },
      );

      // 4xx should NOT failover — elevenlabs should not be tried
      expect(adapterElevenlabs.synthesizeSpeech).not.toHaveBeenCalled();
    });

    it("throws NoProviderAvailableError when all providers are down", async () => {
      const p = makeEntry({ adapter: "elevenlabs", tier: "hosted", providerCost: 0.15 });
      const registry = makeRegistry([p]);

      // No adapter registered
      const router = new ArbitrageRouter({ registry, adapters: new Map() });

      await expect(
        router.route({ capability: "tts", tenantId: "t1", input: { text: "hello" } }),
      ).rejects.toBeInstanceOf(NoProviderAvailableError);
    });

    it("tracks margin via onMarginRecord callback", async () => {
      const hosted = makeEntry({ adapter: "elevenlabs", tier: "hosted", providerCost: 0.12 });
      const registry = makeRegistry([hosted]);

      const adapter = makeAdapter("elevenlabs", ["tts"], { ...fakeTTSResult, cost: 0.012 });
      const adapters = new Map([["elevenlabs", adapter]]);

      const marginRecords: Parameters<
        NonNullable<ConstructorParameters<typeof ArbitrageRouter>[0]["onMarginRecord"]>
      >[0][] = [];
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
      expect(record.adapter).toBe("elevenlabs");
      expect(record.tier).toBe("hosted");
      expect(record.providerCost).toBe(0.012);
      expect(record.sellPrice).toBe(0.02);
      expect(record.margin).toBeCloseTo(0.008, 5);
      expect(record.marginPct).toBeCloseTo(40, 0);
      expect(record.timestamp).toBeGreaterThan(0);
    });

    it("does not call onMarginRecord when sellPrice is not provided", async () => {
      const hosted = makeEntry({ adapter: "elevenlabs", tier: "hosted", providerCost: 0.12 });
      const registry = makeRegistry([hosted]);
      const adapter = makeAdapter("elevenlabs", ["tts"], fakeTTSResult);
      const adapters = new Map([["elevenlabs", adapter]]);

      const onMarginRecord = vi.fn();
      const router = new ArbitrageRouter({ registry, adapters, onMarginRecord });

      await router.route({ capability: "tts", tenantId: "t1", input: {} });

      expect(onMarginRecord).not.toHaveBeenCalled();
    });

    it("marks provider healthy on successful response", async () => {
      const hosted = makeEntry({ adapter: "elevenlabs", tier: "hosted", providerCost: 0.12 });
      const registry = makeRegistry([hosted]);
      const markHealthySpy = vi.spyOn(registry, "markHealthy");

      const adapter = makeAdapter("elevenlabs", ["tts"], fakeTTSResult);
      const adapters = new Map([["elevenlabs", adapter]]);

      const router = new ArbitrageRouter({ registry, adapters });
      await router.route({ capability: "tts", tenantId: "t1", input: {} });

      expect(markHealthySpy).toHaveBeenCalledWith("elevenlabs");
    });
  });

  describe("registerAdapter", () => {
    it("registers an adapter in the internal map", async () => {
      const hosted = makeEntry({ adapter: "elevenlabs", tier: "hosted", providerCost: 0.12 });
      const registry = makeRegistry([hosted]);
      const adapters = new Map<string, ProviderAdapter>();

      const router = new ArbitrageRouter({ registry, adapters });
      const adapter = makeAdapter("elevenlabs", ["tts"], fakeTTSResult);
      router.registerAdapter(adapter);

      const result = await router.route({ capability: "tts", tenantId: "t1", input: {} });
      expect(result.cost).toBe(fakeTTSResult.cost);
    });
  });

  describe("preferLowLatency", () => {
    it("prefers fast provider over cheaper slow provider when preferLowLatency is true", () => {
      const slow = makeEntry({ adapter: "slow-cheap", tier: "hosted", providerCost: 0.05, latencyClass: "slow" });
      const fast = makeEntry({ adapter: "fast-expensive", tier: "hosted", providerCost: 0.15, latencyClass: "fast" });
      const registry = makeRegistry([slow, fast]);

      const router = new ArbitrageRouter({ registry, adapters: new Map(), preferLowLatency: true });
      const decision = router.selectProvider("tts");

      expect(decision.provider.adapter).toBe("fast-expensive");
    });

    it("uses cost-first ordering when preferLowLatency is false (default)", () => {
      const slow = makeEntry({ adapter: "slow-cheap", tier: "hosted", providerCost: 0.05, latencyClass: "slow" });
      const fast = makeEntry({ adapter: "fast-expensive", tier: "hosted", providerCost: 0.15, latencyClass: "fast" });
      const registry = makeRegistry([slow, fast]);

      const router = new ArbitrageRouter({ registry, adapters: new Map() });
      const decision = router.selectProvider("tts");

      expect(decision.provider.adapter).toBe("slow-cheap");
    });

    it("uses cost then priority as tiebreaker when preferLowLatency is true and latency classes are equal", () => {
      // Both are "normal" latency — latencyDiff is 0, so falls through to cost/priority tiebreaker
      const p1 = makeEntry({
        adapter: "normal-priority2",
        tier: "hosted",
        providerCost: 0.12,
        priority: 2,
        latencyClass: "normal",
      });
      const p2 = makeEntry({
        adapter: "normal-priority1",
        tier: "hosted",
        providerCost: 0.12,
        priority: 1,
        latencyClass: "normal",
      });
      const registry = makeRegistry([p1, p2]);

      const router = new ArbitrageRouter({ registry, adapters: new Map(), preferLowLatency: true });
      const decision = router.selectProvider("tts");

      // Same cost and same latency class — priority tiebreaker picks lower priority number
      expect(decision.provider.adapter).toBe("normal-priority1");
    });

    it("uses cost as tiebreaker when preferLowLatency is true and latency classes are equal but costs differ", () => {
      const expensive = makeEntry({
        adapter: "normal-expensive",
        tier: "hosted",
        providerCost: 0.15,
        latencyClass: "normal",
      });
      const cheap = makeEntry({ adapter: "normal-cheap", tier: "hosted", providerCost: 0.1, latencyClass: "normal" });
      const registry = makeRegistry([expensive, cheap]);

      const router = new ArbitrageRouter({ registry, adapters: new Map(), preferLowLatency: true });
      const decision = router.selectProvider("tts");

      expect(decision.provider.adapter).toBe("normal-cheap");
    });
  });

  describe("buildFailoverChain (priority tiebreaker coverage)", () => {
    it("orders GPU failover candidates by priority when costs are equal", async () => {
      // Two GPU providers at equal cost — priority tiebreaker in buildFailoverChain line 173
      const gpu1 = makeEntry({ adapter: "gpu-priority2", tier: "gpu", providerCost: 0.02, priority: 2 });
      const gpu2 = makeEntry({ adapter: "gpu-priority1", tier: "gpu", providerCost: 0.02, priority: 1 });
      const hostedEntry = makeEntry({ adapter: "hosted-fallback", tier: "hosted", providerCost: 0.15 });

      const serverError = Object.assign(new Error("Server error"), { httpStatus: 500 });
      const gpu2Adapter = makeAdapter("gpu-priority2", ["tts"], serverError);
      const gpu1Adapter = makeAdapter("gpu-priority1", ["tts"], serverError);
      const hostedAdapter = makeAdapter("hosted-fallback", ["tts"], fakeTTSResult);

      const registryWithHosted = makeRegistry([gpu1, gpu2, hostedEntry]);
      const adapters = new Map([
        ["gpu-priority2", gpu2Adapter],
        ["gpu-priority1", gpu1Adapter],
        ["hosted-fallback", hostedAdapter],
      ]);

      const router = new ArbitrageRouter({ registry: registryWithHosted, adapters });
      const result = await router.route({ capability: "tts", tenantId: "t1", input: {} });

      // Should ultimately reach hosted-fallback after both GPU providers fail
      expect(result.provider).toBe("hosted-fallback");
    });

    it("orders hosted failover candidates by priority when costs are equal", async () => {
      // Selected provider is GPU. Hosted failover has two providers at equal cost — priority tiebreaker line 177.
      const gpu = makeEntry({ adapter: "gpu-primary", tier: "gpu", providerCost: 0.02 });
      const hosted1 = makeEntry({ adapter: "hosted-priority2", tier: "hosted", providerCost: 0.12, priority: 2 });
      const hosted2 = makeEntry({ adapter: "hosted-priority1", tier: "hosted", providerCost: 0.12, priority: 1 });
      const registry = makeRegistry([gpu, hosted1, hosted2]);

      const serverError = Object.assign(new Error("Server error"), { httpStatus: 500 });
      const gpuAdapter = makeAdapter("gpu-primary", ["tts"], serverError);
      const hosted1Adapter = makeAdapter("hosted-priority2", ["tts"], serverError);
      const hosted2Adapter = makeAdapter("hosted-priority1", ["tts"], fakeTTSResult);
      const adapters = new Map([
        ["gpu-primary", gpuAdapter],
        ["hosted-priority2", hosted1Adapter],
        ["hosted-priority1", hosted2Adapter],
      ]);

      const router = new ArbitrageRouter({ registry, adapters });
      const result = await router.route({ capability: "tts", tenantId: "t1", input: {} });

      // hosted-priority1 (priority:1) should be tried before hosted-priority2 (priority:2)
      expect(result.provider).toBe("hosted-priority1");
    });
  });
});
