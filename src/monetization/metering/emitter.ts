import crypto from "node:crypto";
import type Database from "better-sqlite3";
import type { MeterEvent, MeterEventRow } from "./types.js";

/**
 * Fire-and-forget meter event emitter.
 *
 * Buffers events in memory and flushes them to SQLite in batches,
 * ensuring zero latency impact on the observed API calls.
 */
export class MeterEmitter {
  private buffer: MeterEvent[] = [];
  private readonly insertStmt: Database.Statement;
  private readonly flushTransaction: Database.Transaction<(events: MeterEvent[]) => void>;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private readonly flushIntervalMs: number;
  private readonly batchSize: number;
  private closed = false;

  constructor(
    private readonly db: Database.Database,
    opts: { flushIntervalMs?: number; batchSize?: number } = {},
  ) {
    this.flushIntervalMs = opts.flushIntervalMs ?? 1000;
    this.batchSize = opts.batchSize ?? 100;

    this.insertStmt = db.prepare(`
      INSERT INTO meter_events (id, tenant, cost, charge, capability, provider, timestamp, session_id, duration)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.flushTransaction = db.transaction((events: MeterEvent[]) => {
      for (const e of events) {
        this.insertStmt.run(
          crypto.randomUUID(),
          e.tenant,
          e.cost,
          e.charge,
          e.capability,
          e.provider,
          e.timestamp,
          e.sessionId ?? null,
          e.duration ?? null,
        );
      }
    });

    this.flushTimer = setInterval(() => this.flush(), this.flushIntervalMs);
    // Do not keep the process alive just for metering flushes.
    if (this.flushTimer.unref) {
      this.flushTimer.unref();
    }
  }

  /** Emit a meter event. Non-blocking -- buffers in memory. */
  emit(event: MeterEvent): void {
    if (this.closed) return;
    this.buffer.push(event);
    if (this.buffer.length >= this.batchSize) {
      this.flush();
    }
  }

  /** Flush buffered events to the database. */
  flush(): number {
    if (this.buffer.length === 0) return 0;
    const batch = this.buffer.splice(0);
    try {
      this.flushTransaction(batch);
    } catch {
      // Fire-and-forget: swallow errors so we never impact the caller.
      // In production, a logger would capture this.
      return 0;
    }
    return batch.length;
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
    this.flush();
  }

  /** Query persisted events (for testing / diagnostics). */
  queryEvents(tenant: string, limit = 50): MeterEventRow[] {
    return this.db
      .prepare("SELECT * FROM meter_events WHERE tenant = ? ORDER BY timestamp DESC LIMIT ?")
      .all(tenant, limit) as MeterEventRow[];
  }
}
