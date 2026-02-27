/**
 * Provider registry — reads from the provider_costs table and maintains an
 * in-memory cache of ModelProviderEntry records with health status overlay.
 *
 * WOP-463: Provider arbitrage router.
 */

import type { ProviderCost, RateStore } from "../../admin/rates/rate-store.js";
import { logger } from "../../config/logger.js";
import type { IProviderHealthRepository } from "../provider-health-repository.js";
import type { ModelProviderEntry } from "./types.js";

/** Known self-hosted GPU adapter names (from margin-config.ts) */
const GPU_ADAPTER_NAMES = new Set([
  "chatterbox-tts",
  "self-hosted-llm",
  "self-hosted-whisper",
  "self-hosted-embeddings",
  "self-hosted-sdxl",
]);

export interface ProviderRegistryConfig {
  /** RateStore instance for reading provider_costs */
  rateStore: RateStore;
  /** Repository for persisting provider health overrides */
  healthRepo: IProviderHealthRepository;
  /** Cache TTL in ms (default: 30000 — 30 seconds) */
  cacheTtlMs?: number;
  /** How long an unhealthy provider stays unhealthy before auto-recovery (default: 60000 — 60 seconds) */
  unhealthyTtlMs?: number;
}

export class ProviderRegistry {
  private cache: Map<string, ModelProviderEntry[]> = new Map();
  private lastRefresh = 0;
  private readonly rateStore: RateStore;
  private readonly healthRepo: IProviderHealthRepository;
  private readonly cacheTtlMs: number;
  private readonly unhealthyTtlMs: number;

  constructor(config: ProviderRegistryConfig) {
    this.rateStore = config.rateStore;
    this.healthRepo = config.healthRepo;
    this.cacheTtlMs = config.cacheTtlMs ?? 30_000;
    this.unhealthyTtlMs = config.unhealthyTtlMs ?? 60_000;
  }

  /** Get all providers for a capability, with health status applied. */
  async getProviders(capability: string): Promise<ModelProviderEntry[]> {
    if (Date.now() - this.lastRefresh > this.cacheTtlMs) {
      await this.refresh();
    }

    const entries = this.cache.get(capability) ?? [];

    return Promise.all(
      entries.map(async (entry) => {
        const override = await this.healthRepo.get(entry.adapter);
        if (!override) return entry;

        // Auto-recovery: if unhealthy TTL has elapsed, clear the override
        if (!override.healthy && Date.now() - override.markedAt > this.unhealthyTtlMs) {
          this.healthRepo
            .markHealthy(entry.adapter)
            .catch((err) => logger.warn("Failed to clear health override", { adapter: entry.adapter, err }));
          return entry;
        }

        return { ...entry, healthy: override.healthy };
      }),
    );
  }

  /** Mark a provider as unhealthy (called on 5xx errors). */
  markUnhealthy(adapter: string): void {
    this.healthRepo
      .markUnhealthy(adapter)
      .catch((err) => logger.warn("Failed to persist unhealthy state", { adapter, err }));
  }

  /** Mark a provider as healthy (called on successful responses or health probes). */
  markHealthy(adapter: string): void {
    this.healthRepo
      .markHealthy(adapter)
      .catch((err) => logger.warn("Failed to persist healthy state", { adapter, err }));
  }

  /** Force-refresh the cache from DB. */
  async refresh(): Promise<void> {
    // Load all active provider costs grouped by capability
    const { entries } = await this.rateStore.listProviderCosts({ isActive: true, limit: 250 });

    // Group by capability
    const byCapability = new Map<string, ModelProviderEntry[]>();
    for (const row of entries) {
      const entry = this.mapRow(row);
      const list = byCapability.get(row.capability) ?? [];
      list.push(entry);
      byCapability.set(row.capability, list);
    }

    // Sort each capability's entries: GPU first, then by cost, then by priority
    for (const [cap, providerEntries] of byCapability) {
      providerEntries.sort((a, b) => {
        // GPU tier first
        if (a.tier !== b.tier) {
          return a.tier === "gpu" ? -1 : 1;
        }
        // Within same tier, sort by cost ascending
        if (a.providerCost !== b.providerCost) {
          return a.providerCost - b.providerCost;
        }
        // Tiebreaker: priority ascending (lower = preferred)
        return a.priority - b.priority;
      });
      byCapability.set(cap, providerEntries);
    }

    this.cache = byCapability;
    this.lastRefresh = Date.now();
  }

  /** Map a ProviderCost DB row to a ModelProviderEntry. */
  private mapRow(row: ProviderCost): ModelProviderEntry {
    const tier: "gpu" | "hosted" =
      GPU_ADAPTER_NAMES.has(row.adapter) || row.adapter.startsWith("self-hosted-") ? "gpu" : "hosted";

    const latencyClassMap: Record<string, "fast" | "normal" | "slow"> = {
      fast: "fast",
      standard: "normal",
      batch: "slow",
    };
    const latencyClass = latencyClassMap[row.latency_class] ?? "normal";

    return {
      capability: row.capability,
      adapter: row.adapter,
      tier,
      providerCost: row.cost_usd,
      costUnit: row.unit,
      healthy: true, // default; overrides applied in getProviders()
      priority: row.priority,
      latencyClass,
      enabled: row.is_active,
    };
  }
}
