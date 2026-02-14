import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { MeterEvent } from "./types.js";

/**
 * Dead-Letter Queue for meter events that failed to flush after max retries.
 *
 * Events written here are permanently failed and require manual intervention
 * to recover. This ensures we never silently drop billing events.
 */
export class MeterDLQ {
  private readonly dlqPath: string;

  constructor(dlqPath: string) {
    this.dlqPath = dlqPath;
    this.ensureDir();
  }

  private ensureDir(): void {
    const dir = dirname(this.dlqPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  /**
   * Append a failed event to the DLQ with failure metadata.
   */
  append(event: MeterEvent & { id: string }, error: string, retries: number): void {
    const dlqEntry = {
      ...event,
      dlq_timestamp: Date.now(),
      dlq_error: error,
      dlq_retries: retries,
    };

    const line = `${JSON.stringify(dlqEntry)}\n`;
    appendFileSync(this.dlqPath, line, { encoding: "utf8", flag: "a" });
  }

  /**
   * Read all events from the DLQ for manual recovery.
   */
  readAll(): Array<
    MeterEvent & {
      id: string;
      dlq_timestamp: number;
      dlq_error: string;
      dlq_retries: number;
    }
  > {
    if (!existsSync(this.dlqPath)) {
      return [];
    }

    const content = readFileSync(this.dlqPath, "utf8");
    if (!content.trim()) {
      return [];
    }

    const entries: Array<
      MeterEvent & {
        id: string;
        dlq_timestamp: number;
        dlq_error: string;
        dlq_retries: number;
      }
    > = [];
    for (const line of content.trim().split("\n")) {
      try {
        entries.push(JSON.parse(line));
      } catch {
        // Skip malformed lines (e.g., from incomplete writes during error conditions).
      }
    }
    return entries;
  }

  /**
   * Get the number of events in the DLQ.
   */
  count(): number {
    return this.readAll().length;
  }
}
