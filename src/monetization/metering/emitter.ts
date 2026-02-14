import type Database from "better-sqlite3";
import { MeterDLQ } from "./dlq.js";
import type { MeterEvent, MeterEventRow } from "./types.js";
import { MeterWAL } from "./wal.js";

const DEFAULT_WAL_PATH = process.env.METER_WAL_PATH ?? "./data/meter-wal.jsonl";
const DEFAULT_DLQ_PATH = process.env.METER_DLQ_PATH ?? "./data/meter-dlq.jsonl";
const DEFAULT_MAX_RETRIES = Number.parseInt(process.env.METER_MAX_RETRIES ?? "3", 10);

/**
 * Fire-and-forget meter event emitter with fail-closed durability.
 *
 * Buffers events in memory and flushes them to SQLite in batches,
 * ensuring zero latency impact on the observed API calls.
 *
 * FAIL-CLOSED POLICY:
 * - Events are written to WAL (write-ahead log) on disk BEFORE buffering
 * - If SQLite flush fails, events are retried up to MAX_RETRIES times
 * - After MAX_RETRIES, events move to DLQ (dead-letter queue) for manual recovery
 * - On startup, unflushed WAL events are replayed idempotently
 */
export class MeterEmitter {
  private buffer: Array<MeterEvent & { id: string }> = [];
  private readonly insertStmt: Database.Statement;
  private readonly flushTransaction: Database.Transaction<(events: Array<MeterEvent & { id: string }>) => void>;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private readonly flushIntervalMs: number;
  private readonly batchSize: number;
  private readonly maxRetries: number;
  private closed = false;
  private readonly wal: MeterWAL;
  private readonly dlq: MeterDLQ;
  private readonly retryCount = new Map<string, number>();

  constructor(
    private readonly db: Database.Database,
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

    this.insertStmt = db.prepare(`
      INSERT INTO meter_events (id, tenant, cost, charge, capability, provider, timestamp, session_id, duration)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.flushTransaction = db.transaction((events: Array<MeterEvent & { id: string }>) => {
      for (const e of events) {
        this.insertStmt.run(
          e.id,
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

    // Replay any unflushed WAL events from a previous session.
    this.replayWAL();

    this.flushTimer = setInterval(() => this.flush(), this.flushIntervalMs);
    // Do not keep the process alive just for metering flushes.
    if (this.flushTimer.unref) {
      this.flushTimer.unref();
    }
  }

  /**
   * Replay unflushed events from the WAL on startup.
   * Idempotent: skips events already in the database.
   */
  private replayWAL(): void {
    const walEvents = this.wal.readAll();
    if (walEvents.length === 0) return;

    // Check which events are already in the database.
    const existingIds = new Set<string>();
    const checkStmt = this.db.prepare("SELECT id FROM meter_events WHERE id = ?");
    for (const e of walEvents) {
      const row = checkStmt.get(e.id) as { id: string } | undefined;
      if (row) {
        existingIds.add(e.id);
      }
    }

    // Replay only new events.
    const toReplay = walEvents.filter((e) => !existingIds.has(e.id));
    if (toReplay.length > 0) {
      this.buffer.push(...toReplay);
      this.flush();
    }

    // Clean up WAL after successful replay.
    if (this.buffer.length === 0) {
      this.wal.clear();
    }
  }

  /** Emit a meter event. Non-blocking -- buffers in memory after WAL write. */
  emit(event: MeterEvent): void {
    if (this.closed) return;

    // FAIL-CLOSED: Write to WAL first, then buffer.
    const eventWithId = this.wal.append(event);
    this.buffer.push(eventWithId);

    if (this.buffer.length >= this.batchSize) {
      this.flush();
    }
  }

  /** Flush buffered events to the database with retry and DLQ logic. */
  flush(): number {
    if (this.buffer.length === 0) return 0;
    const batch = this.buffer.splice(0);

    try {
      this.flushTransaction(batch);

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
          // Max retries exceeded — move to DLQ.
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
    this.flush();
  }

  /** Query persisted events (for testing / diagnostics). */
  queryEvents(tenant: string, limit = 50): MeterEventRow[] {
    return this.db
      .prepare("SELECT * FROM meter_events WHERE tenant = ? ORDER BY timestamp DESC LIMIT ?")
      .all(tenant, limit) as MeterEventRow[];
  }
}
