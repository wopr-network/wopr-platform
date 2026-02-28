import type { Credit } from "../credit.js";

/** A single metering event emitted by the socket after observing an adapter call. */
export interface MeterEvent {
  /** Tenant identifier (who). */
  tenant: string;
  /** Upstream cost from the provider (as Credit value object). */
  cost: Credit;
  /** What we charge the tenant (cost x multiplier, as Credit value object). */
  charge: Credit;
  /** Capability used (embeddings, voice, search, chat, etc.). */
  capability: string;
  /** Which adapter fulfilled the request (replicate, deepgram, elevenlabs, etc.). */
  provider: string;
  /** Unix epoch ms when the event occurred. */
  timestamp: number;
  /** Groups events from one continuous session (voice calls, etc.). */
  sessionId?: string;
  /** Session duration in ms (for usage dashboard display). */
  duration?: number;
  /** Generic usage measurement — units + unitType (WOP-512). */
  usage?: {
    /** Quantity consumed (tokens, seconds, characters, pixels, requests, etc.). */
    units: number;
    /** What the units represent. */
    unitType: string;
  };
  /** Pricing tier for billing multiplier lookup (WOP-512). */
  tier?: "wopr" | "branded" | "byok";
  /** Provider-specific details (model name, voice ID, resolution, etc.) (WOP-512). */
  metadata?: Record<string, unknown>;
}

/** A meter event row as stored in SQLite. */
export interface MeterEventRow {
  id: string;
  tenant: string;
  cost: number;
  charge: number;
  capability: string;
  provider: string;
  timestamp: number;
  session_id: string | null;
  duration: number | null;
  /** WOP-512: Generic usage fields */
  usage_units: number | null;
  usage_unit_type: string | null;
  tier: string | null;
  metadata: string | null; // JSON string
}

/** Per-tenant usage summary for a given time window. */
export interface UsageSummary {
  tenant: string;
  capability: string;
  provider: string;
  /** Number of events aggregated. */
  event_count: number;
  /** Sum of upstream costs. */
  total_cost: number;
  /** Sum of charges to tenant. */
  total_charge: number;
  /** Sum of durations in ms (for session-based capabilities). */
  total_duration: number;
  /** Start of the aggregation window (unix epoch ms). */
  window_start: number;
  /** End of the aggregation window (unix epoch ms). */
  window_end: number;
}

/** A billing period boundary (e.g., hourly). */
export interface BillingPeriod {
  /** Start of the billing period (unix epoch ms, inclusive). */
  start: number;
  /** End of the billing period (unix epoch ms, exclusive). */
  end: number;
}

/** A per-tenant, per-billing-period rolled-up summary row as stored in SQLite. */
export interface BillingPeriodSummary {
  id: string;
  tenant: string;
  capability: string;
  provider: string;
  event_count: number;
  total_cost: number;
  total_charge: number;
  total_duration: number;
  period_start: number;
  period_end: number;
  /** Unix epoch ms when this row was last (re-)computed. */
  updated_at: number;
}
