import { desc, eq } from "drizzle-orm";
import type { DrizzleDb } from "../../db/index.js";
import { meterEvents } from "../../db/schema/meter-events.js";
import { MeterDLQ } from "./dlq.js";
import type { MeterEvent, MeterEventRow } from "./types.js";
import { MeterWAL } from "./wal.js";

const DEFAULT_WAL_PATH = process.env.METER_WAL_PATH ?? "./data/meter-wal.jsonl";
const DEFAULT_DLQ_PATH = process.env.METER_DLQ_PATH ?? "./data/meter-dlq.jsonl";
const DEFAULT_MAX_RETRIES = Number.parseInt(process.env.METER_MAX_RETRIES ?? "3", 10);

export interface IMeterEmitter {
  emit(event: MeterEvent): void;
  flush(): Promise<number>;
  readonly pending: number;
  close(): void;
  queryEvents(tenant: string, limit?: number): Promise<MeterEventRow[]>;
}

/**
 * Fire-and-forget meter event emitter with fail-closed durability.
 *
 * Buffers events in memory and flushes them to the database in batches,
 * ensuring zero latency impact on the observed API calls.
 *
 * FAIL-CLOSED POLICY:
 * - Events are written to WAL (write-ahead log) on disk BEFORE buffering
 * - If flush fails, events are retried up to MAX_RETRIES times
 * - After MAX_RETRIES, events move to DLQ (dead-letter queue) for manual recovery
 * - On startup, unflushed WAL events are replayed idempotently
 */
export class DrizzleMeterEmitter implements IMeterEmitter {
  private buffer: Array<MeterEvent & { id: string }> = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private readonly flushIntervalMs: number;
  private readonly batchSize: number;
  private readonly maxRetries: number;
  private closed = false;
  private readonly wal: MeterWAL;
  private readonly dlq: MeterDLQ;
  private readonly retryCount = new Map<string, number>();
  /** Resolves when the initial WAL replay has completed. */
  readonly ready: Promise<void>;

  constructor(
    private readonly db: DrizzleDb,
    opts: {
      flushIntervalMs?: number;
      batchSize?: number;
      walPath?: string;
      dlqPath?: string;
      maxRetries?: number;
    } = {},
  ) {
    this.flushIntervalMs = opts.flushIntervalMs ?? 1000;
    this.batchSize = opts.batchSize ?? 100;
    this.maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;

    this.wal = new MeterWAL(opts.walPath ?? DEFAULT_WAL_PATH);
    this.dlq = new MeterDLQ(opts.dlqPath ?? DEFAULT_DLQ_PATH);

    // Replay any unflushed WAL events from a previous session.
    this.ready = this.replayWAL();

    this.flushTimer = setInterval(() => this.flush(), this.flushIntervalMs);
    // Do not keep the process alive just for metering flushes.
    if (this.flushTimer.unref) {
      this.flushTimer.unref();
    }
  }

  /**
   * Replay unflushed events from the WAL on startup.
   * Idempotent: skips events already in the database.
   * Returns a promise that resolves when the replay is complete.
   */
  private async replayWAL(): Promise<void> {
    const walEvents = this.wal.readAll();
    if (walEvents.length === 0) return;

    await this.replayWALAsync(walEvents);
  }

  private async replayWALAsync(walEvents: Array<MeterEvent & { id: string }>): Promise<void> {
    // Check which events are already in the database.
    const existingIds = new Set<string>();
    for (const e of walEvents) {
      const row = (await this.db.select({ id: meterEvents.id }).from(meterEvents).where(eq(meterEvents.id, e.id)))[0];
      if (row) {
        existingIds.add(e.id);
      }
    }

    // Replay only new events.
    const toReplay = walEvents.filter((e) => !existingIds.has(e.id));
    if (toReplay.length > 0) {
      this.buffer.push(...toReplay);
      const flushed = await this.flush();
      if (flushed === 0) {
        // Flush failed -- events remain in WAL and buffer for retry.
        return;
      }
    }

    // Remove already-persisted events from WAL (idempotent cleanup).
    if (existingIds.size > 0) {
      this.wal.remove(existingIds);
    }
  }

  /** Emit a meter event. Non-blocking -- buffers in memory after WAL write. */
  emit(event: MeterEvent): void {
    if (this.closed) return;

    // FAIL-CLOSED: Write to WAL first, then buffer.
    const eventWithId = this.wal.append(event);
    this.buffer.push(eventWithId);

    if (this.buffer.length >= this.batchSize) {
      void this.flush();
    }
  }

  /** Flush buffered events to the database with retry and DLQ logic. */
  async flush(): Promise<number> {
    if (this.buffer.length === 0) return 0;
    const batch = this.buffer.splice(0);

    try {
      await this.db.transaction(async (tx) => {
        for (const e of batch) {
          await tx.insert(meterEvents).values({
            id: e.id,
            tenant: e.tenant,
            cost: e.cost,
            charge: e.charge,
            capability: e.capability,
            provider: e.provider,
            timestamp: e.timestamp,
            sessionId: e.sessionId ?? null,
            duration: e.duration ?? null,
            usageUnits: e.usage?.units ?? null,
            usageUnitType: e.usage?.unitType ?? null,
            tier: e.tier ?? null,
            metadata: e.metadata ? JSON.stringify(e.metadata) : null,
          });
        }
      });

      // Success: remove from WAL and reset retry counters.
      const flushedIds = new Set(batch.map((e) => e.id));
      this.wal.remove(flushedIds);
      for (const id of flushedIds) {
        this.retryCount.delete(id);
      }

      return batch.length;
    } catch (error) {
      // Failure: track retries and move to DLQ if max exceeded.
      const toRetry: Array<MeterEvent & { id: string }> = [];
      const toDLQ: Array<MeterEvent & { id: string }> = [];

      for (const event of batch) {
        const retries = (this.retryCount.get(event.id) ?? 0) + 1;
        this.retryCount.set(event.id, retries);

        if (retries >= this.maxRetries) {
          // Max retries exceeded -- move to DLQ.
          toDLQ.push(event);
          this.dlq.append(event, String(error), retries);
          this.retryCount.delete(event.id);
        } else {
          // Retry on next flush.
          toRetry.push(event);
        }
      }

      // Remove DLQ events from WAL (they're now in DLQ).
      if (toDLQ.length > 0) {
        const dlqIds = new Set(toDLQ.map((e) => e.id));
        this.wal.remove(dlqIds);
      }

      // Re-add retry events to buffer.
      this.buffer.unshift(...toRetry);

      return 0;
    }
  }

  /** Number of events currently buffered. */
  get pending(): number {
    return this.buffer.length;
  }

  /** Stop the flush timer and flush remaining events. */
  close(): void {
    this.closed = true;
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    void this.flush();
  }

  /** Query persisted events (for testing / diagnostics). */
  async queryEvents(tenant: string, limit = 50): Promise<MeterEventRow[]> {
    const rows = await this.db
      .select()
      .from(meterEvents)
      .where(eq(meterEvents.tenant, tenant))
      .orderBy(desc(meterEvents.timestamp))
      .limit(limit);

    // Map Drizzle camelCase columns back to snake_case MeterEventRow interface
    return rows.map((r) => ({
      id: r.id,
      tenant: r.tenant,
      cost: r.cost,
      charge: r.charge,
      capability: r.capability,
      provider: r.provider,
      timestamp: r.timestamp,
      session_id: r.sessionId,
      duration: r.duration,
      usage_units: r.usageUnits,
      usage_unit_type: r.usageUnitType,
      tier: r.tier,
      metadata: r.metadata,
    }));
  }
}

// Backward-compat alias.
export { DrizzleMeterEmitter as MeterEmitter };
