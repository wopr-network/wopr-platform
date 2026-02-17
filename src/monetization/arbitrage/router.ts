/**
 * Arbitrage router — routes capability requests to the best available provider.
 *
 * Two-tier routing: GPU first (cheapest, highest margin), then hosted (cheapest
 * third-party). Failover on 5xx. Margin tracked per-request.
 *
 * WOP-463: Provider arbitrage router.
 */

import type { AdapterCapability, AdapterResult, ProviderAdapter } from "../adapters/types.js";
import type { ProviderRegistry } from "./provider-registry.js";
import type { MarginRecord, ModelProviderEntry, RoutingDecision } from "./types.js";
import { NoProviderAvailableError } from "./types.js";

/** Map from capability to the adapter method name that fulfills it (mirrors socket.ts) */
const CAPABILITY_METHOD: Record<AdapterCapability, keyof ProviderAdapter> = {
  transcription: "transcribe",
  "image-generation": "generateImage",
  "text-generation": "generateText",
  tts: "synthesizeSpeech",
  embeddings: "embed",
};

export interface ArbitrageRouterConfig {
  /** Provider registry for looking up available providers */
  registry: ProviderRegistry;
  /** Map of adapter name -> ProviderAdapter instance */
  adapters: Map<string, ProviderAdapter>;
  /** Optional: callback for margin tracking */
  onMarginRecord?: (record: MarginRecord) => void;
  /** Optional: prefer lower-latency provider even if more expensive (default: false) */
  preferLowLatency?: boolean;
}

export interface ArbitrageRequest {
  /** Capability being requested */
  capability: AdapterCapability;
  /** Tenant making the request */
  tenantId: string;
  /** The request payload */
  input: unknown;
  /** Optional model specifier (for model-level arbitrage like "gemini-2.5-pro") */
  model?: string;
  /** Sell price that will be charged to user (for margin tracking) */
  sellPrice?: number;
}

export class ArbitrageRouter {
  private readonly registry: ProviderRegistry;
  private readonly adapters: Map<string, ProviderAdapter>;
  private readonly onMarginRecord?: (record: MarginRecord) => void;
  private readonly preferLowLatency: boolean;

  constructor(config: ArbitrageRouterConfig) {
    this.registry = config.registry;
    this.adapters = config.adapters;
    this.onMarginRecord = config.onMarginRecord;
    this.preferLowLatency = config.preferLowLatency ?? false;
  }

  /**
   * Route a request to the best available provider.
   * Tries GPU tier first, falls back to hosted tier (cheapest first).
   * On 5xx errors, retries with next provider in the failover chain.
   */
  async route<T>(request: ArbitrageRequest): Promise<AdapterResult<T>> {
    const decision = this.selectProvider(request.capability, request.model);
    const orderedCandidates = this.buildFailoverChain(decision);

    for (const entry of orderedCandidates) {
      const adapter = this.adapters.get(entry.adapter);
      if (!adapter) continue;

      const method = CAPABILITY_METHOD[request.capability];
      const fn = adapter[method] as ((input: unknown) => Promise<AdapterResult<T>>) | undefined;
      if (!fn) continue;

      try {
        const result = await fn.call(adapter, request.input);

        // Mark healthy on success
        this.registry.markHealthy(entry.adapter);

        // Track margin if sell price is known
        if (request.sellPrice !== undefined && this.onMarginRecord) {
          this.onMarginRecord({
            tenantId: request.tenantId,
            capability: request.capability,
            adapter: entry.adapter,
            tier: entry.tier,
            providerCost: result.cost,
            sellPrice: request.sellPrice,
            margin: request.sellPrice - result.cost,
            marginPct: request.sellPrice > 0 ? ((request.sellPrice - result.cost) / request.sellPrice) * 100 : 0,
            timestamp: Date.now(),
          });
        }

        return result;
      } catch (error) {
        const httpStatus = (error as { httpStatus?: number }).httpStatus;
        if (httpStatus !== undefined && httpStatus >= 500 && httpStatus < 600) {
          // 5xx — mark unhealthy and try next provider
          this.registry.markUnhealthy(entry.adapter);
          continue;
        }
        // Non-5xx errors (4xx, network, etc.) — do NOT failover, rethrow
        throw error;
      }
    }

    throw new NoProviderAvailableError(request.capability);
  }

  /**
   * Select the best provider without executing.
   * Useful for cost estimation and admin dashboards.
   */
  selectProvider(capability: string, _model?: string): RoutingDecision {
    const allProviders = this.registry.getProviders(capability);
    // Filter to enabled + healthy only
    const candidates = allProviders.filter((p) => p.enabled && p.healthy);

    // Apply latency preference if configured
    const sortFn = this.preferLowLatency
      ? (a: ModelProviderEntry, b: ModelProviderEntry) => {
          const latencyOrder = { fast: 0, normal: 1, slow: 2 };
          const latencyDiff = latencyOrder[a.latencyClass] - latencyOrder[b.latencyClass];
          if (latencyDiff !== 0) return latencyDiff;
          return a.providerCost - b.providerCost || a.priority - b.priority;
        }
      : (a: ModelProviderEntry, b: ModelProviderEntry) => a.providerCost - b.providerCost || a.priority - b.priority;

    // Tier 1: GPU providers, sorted by cost then priority
    const gpu = candidates.filter((p) => p.tier === "gpu").sort(sortFn);

    if (gpu.length > 0) {
      return {
        provider: gpu[0],
        candidates,
        reason: "gpu-cheapest",
      };
    }

    // Tier 2: Hosted providers, sorted by cost then priority
    const hosted = candidates.filter((p) => p.tier === "hosted").sort(sortFn);

    if (hosted.length > 0) {
      return {
        provider: hosted[0],
        candidates,
        reason: "hosted-cheapest",
      };
    }

    throw new NoProviderAvailableError(capability);
  }

  /** Register an adapter instance. */
  registerAdapter(adapter: ProviderAdapter): void {
    this.adapters.set(adapter.name, adapter);
  }

  /** Build the failover chain: selected provider first, then remaining GPU by cost, then hosted by cost. */
  private buildFailoverChain(decision: RoutingDecision): ModelProviderEntry[] {
    const candidates = decision.candidates.filter((p) => p.enabled && p.healthy);

    const chain: ModelProviderEntry[] = [decision.provider];

    const gpuRemaining = candidates
      .filter((p) => p.tier === "gpu" && p.adapter !== decision.provider.adapter)
      .sort((a, b) => a.providerCost - b.providerCost || a.priority - b.priority);

    const hostedRemaining = candidates
      .filter((p) => p.tier === "hosted" && p.adapter !== decision.provider.adapter)
      .sort((a, b) => a.providerCost - b.providerCost || a.priority - b.priority);

    chain.push(...gpuRemaining, ...hostedRemaining);
    return chain;
  }
}
