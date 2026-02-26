/**
 * Adapter socket — the orchestrator between capability requests and provider adapters.
 *
 * The socket layer is the glue: it receives a capability request with a tenant ID,
 * selects the right adapter, calls it, emits a MeterEvent, and returns the result.
 * Adapters never touch metering or billing — that's the socket's job.
 */

import type { AdapterCapability, AdapterResult, ProviderAdapter } from "../adapters/types.js";
import { withMargin } from "../adapters/types.js";
import type { BudgetChecker, SpendLimits } from "../budget/budget-checker.js";
import type { MeterEmitter } from "../metering/emitter.js";

export interface SocketConfig {
  /** MeterEmitter instance for usage tracking */
  meter: MeterEmitter;
  /** BudgetChecker instance for pre-call budget validation */
  budgetChecker?: BudgetChecker;
  /** Default margin multiplier (default: 1.3) */
  defaultMargin?: number;
}

export interface SocketRequest {
  /** Who is making the request */
  tenantId: string;
  /** What capability is needed */
  capability: AdapterCapability;
  /** The request payload (matches the capability's input type) */
  input: unknown;
  /** Optional: force a specific adapter by name */
  adapter?: string;
  /** Optional: override margin for this request */
  margin?: number;
  /** Optional: session ID for grouping events */
  sessionId?: string;
  /** Whether the tenant is using their own API key (BYOK) */
  byok?: boolean;
  /** Optional: tenant's spend limits (for budget checking) */
  spendLimits?: SpendLimits;
  /** Pricing tier: "standard" (self-hosted, cheap) or "premium" (third-party brand-name) */
  pricingTier?: "standard" | "premium";
  /** @deprecated Use spendLimits instead. Kept for backwards compat during migration. */
  tier?: string;
}

/** Map from capability to the adapter method name that fulfills it */
const CAPABILITY_METHOD: Record<AdapterCapability, keyof ProviderAdapter> = {
  transcription: "transcribe",
  "image-generation": "generateImage",
  "text-generation": "generateText",
  tts: "synthesizeSpeech",
  embeddings: "embed",
};

export class AdapterSocket {
  private readonly adapters = new Map<string, ProviderAdapter>();
  private readonly meter: MeterEmitter;
  private readonly budgetChecker?: BudgetChecker;
  private readonly defaultMargin: number;

  constructor(config: SocketConfig) {
    this.meter = config.meter;
    this.budgetChecker = config.budgetChecker;
    this.defaultMargin = config.defaultMargin ?? 1.3;
  }

  /** Register an adapter. Overwrites any existing adapter with the same name. */
  register(adapter: ProviderAdapter): void {
    this.adapters.set(adapter.name, adapter);
  }

  /** Execute a capability request against the best adapter. */
  async execute<T>(request: SocketRequest): Promise<T> {
    // Pre-call budget check — fail-closed if enabled and budget exceeded
    const limits = request.spendLimits;
    if (this.budgetChecker && limits && !request.byok) {
      const budgetResult = await this.budgetChecker.check(request.tenantId, limits);
      if (!budgetResult.allowed) {
        const error = Object.assign(new Error(budgetResult.reason ?? "Budget exceeded"), {
          httpStatus: budgetResult.httpStatus ?? 429,
          budgetCheck: budgetResult,
        });
        throw error;
      }
    }

    const adapter = this.resolveAdapter(request);
    const method = CAPABILITY_METHOD[request.capability];
    const fn = adapter[method] as ((input: unknown) => Promise<AdapterResult<T>>) | undefined;

    if (!fn) {
      throw new Error(
        `Adapter "${adapter.name}" is registered for "${request.capability}" but does not implement "${String(method)}"`,
      );
    }

    // Call the adapter — if it throws, no meter event is emitted.
    const adapterResult = await fn.call(adapter, request.input);

    // Compute charge if the adapter didn't supply one
    const margin = request.margin ?? this.defaultMargin;
    const charge = adapterResult.charge ?? withMargin(adapterResult.cost, margin);

    // Emit meter event — BYOK tenants get zero cost/charge (WOP-512)
    const isByok = request.byok === true;
    this.meter.emit({
      tenant: request.tenantId,
      cost: isByok ? 0 : adapterResult.cost,
      charge: isByok ? 0 : charge,
      capability: request.capability,
      provider: adapter.name,
      timestamp: Date.now(),
      ...(request.sessionId ? { sessionId: request.sessionId } : {}),
      tier: isByok ? "byok" : adapter.selfHosted ? "wopr" : "branded",
    });

    return adapterResult.result;
  }

  /** List all capabilities across all registered adapters (deduplicated). */
  capabilities(): AdapterCapability[] {
    const seen = new Set<AdapterCapability>();
    for (const adapter of this.adapters.values()) {
      for (const cap of adapter.capabilities) {
        seen.add(cap);
      }
    }
    return [...seen];
  }

  /** Resolve which adapter to use for a request. */
  private resolveAdapter(request: SocketRequest): ProviderAdapter {
    // If a specific adapter is requested, use it (highest priority)
    if (request.adapter) {
      const adapter = this.adapters.get(request.adapter);
      if (!adapter) {
        throw new Error(`Adapter "${request.adapter}" is not registered`);
      }
      if (!adapter.capabilities.includes(request.capability)) {
        throw new Error(`Adapter "${request.adapter}" does not support capability "${request.capability}"`);
      }
      return adapter;
    }

    // If a pricing tier is specified, prefer adapters matching that tier
    if (request.pricingTier) {
      const preferSelfHosted = request.pricingTier === "standard";

      // Find first adapter matching tier preference, fall back to any with capability
      for (const adapter of this.adapters.values()) {
        if (!adapter.capabilities.includes(request.capability)) continue;

        const isSelfHosted = adapter.selfHosted === true;
        if (preferSelfHosted === isSelfHosted) {
          return adapter;
        }
      }

      // Fall back to any adapter with the capability if preferred tier unavailable
      for (const adapter of this.adapters.values()) {
        if (adapter.capabilities.includes(request.capability)) {
          return adapter;
        }
      }
    }

    // Otherwise, find the first adapter that supports the capability
    for (const adapter of this.adapters.values()) {
      if (adapter.capabilities.includes(request.capability)) {
        return adapter;
      }
    }

    throw new Error(`No adapter registered for capability "${request.capability}"`);
  }
}
