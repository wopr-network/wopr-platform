/** A single metering event emitted by the socket after observing an adapter call. */
export interface MeterEvent {
  /** Tenant identifier (who). */
  tenant: string;
  /** Upstream cost from the provider. */
  cost: number;
  /** What we charge the tenant (cost x multiplier). */
  charge: number;
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
