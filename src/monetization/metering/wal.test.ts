import { existsSync, mkdirSync, rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Credit } from "../credit.js";
import { MeterDLQ } from "./dlq.js";
import type { MeterEvent } from "./types.js";
import { MeterWAL } from "./wal.js";

const TEST_DIR = "/tmp/wopr-wal-test";
const TEST_WAL_PATH = `${TEST_DIR}/test-wal.jsonl`;
const TEST_DLQ_PATH = `${TEST_DIR}/test-dlq.jsonl`;

function makeEvent(overrides: Partial<MeterEvent> = {}): MeterEvent {
  return {
    tenant: "tenant-1",
    cost: Credit.fromDollars(0.001),
    charge: Credit.fromDollars(0.002),
    capability: "embeddings",
    provider: "openai",
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("MeterWAL", () => {
  let wal: MeterWAL;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
    mkdirSync(TEST_DIR, { recursive: true });
    wal = new MeterWAL(TEST_WAL_PATH);
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
  });

  it("appends events to the WAL", () => {
    const event = makeEvent();
    const result = wal.append(event);

    expect(result.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(result.tenant).toBe("tenant-1");
    expect(wal.count()).toBe(1);
  });

  it("preserves event ID if provided", () => {
    const event = { ...makeEvent(), id: "custom-id-123" };
    const result = wal.append(event);

    expect(result.id).toBe("custom-id-123");
  });

  it("generates UUID if ID not provided", () => {
    const event = makeEvent();
    const result = wal.append(event);

    expect(result.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it("readAll returns events in order", () => {
    wal.append(makeEvent({ tenant: "t-1" }));
    wal.append(makeEvent({ tenant: "t-2" }));
    wal.append(makeEvent({ tenant: "t-3" }));

    const events = wal.readAll();
    expect(events).toHaveLength(3);
    expect(events[0].tenant).toBe("t-1");
    expect(events[1].tenant).toBe("t-2");
    expect(events[2].tenant).toBe("t-3");
  });

  it("readAll returns empty array for empty WAL", () => {
    const events = wal.readAll();
    expect(events).toEqual([]);
  });

  it("remove deletes specific events", () => {
    const e1 = wal.append(makeEvent({ tenant: "t-1" }));
    const e2 = wal.append(makeEvent({ tenant: "t-2" }));
    const e3 = wal.append(makeEvent({ tenant: "t-3" }));

    wal.remove(new Set([e2.id]));

    const events = wal.readAll();
    expect(events).toHaveLength(2);
    expect(events[0].id).toBe(e1.id);
    expect(events[1].id).toBe(e3.id);
  });

  it("remove with empty set does nothing", () => {
    wal.append(makeEvent());
    wal.remove(new Set());

    expect(wal.count()).toBe(1);
  });

  it("remove all events clears the WAL file", () => {
    const e1 = wal.append(makeEvent());
    const e2 = wal.append(makeEvent());

    wal.remove(new Set([e1.id, e2.id]));

    expect(wal.isEmpty()).toBe(true);
    expect(existsSync(TEST_WAL_PATH)).toBe(false);
  });

  it("clear removes the WAL file", () => {
    wal.append(makeEvent());
    expect(existsSync(TEST_WAL_PATH)).toBe(true);

    wal.clear();

    expect(existsSync(TEST_WAL_PATH)).toBe(false);
    expect(wal.isEmpty()).toBe(true);
  });

  it("isEmpty returns true for non-existent WAL", () => {
    expect(wal.isEmpty()).toBe(true);
  });

  it("isEmpty returns false after append", () => {
    wal.append(makeEvent());
    expect(wal.isEmpty()).toBe(false);
  });

  it("count returns 0 for empty WAL", () => {
    expect(wal.count()).toBe(0);
  });

  it("handles multiple appends without data loss", () => {
    for (let i = 0; i < 100; i++) {
      wal.append(makeEvent({ tenant: `t-${i}` }));
    }

    expect(wal.count()).toBe(100);
  });
});

describe("MeterDLQ", () => {
  let dlq: MeterDLQ;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
    mkdirSync(TEST_DIR, { recursive: true });
    dlq = new MeterDLQ(TEST_DLQ_PATH);
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
  });

  it("appends failed events with metadata", () => {
    const event = { ...makeEvent(), id: "failed-event-1" };
    dlq.append(event, "Database connection lost", 3);

    const entries = dlq.readAll();
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe("failed-event-1");
    expect(entries[0].tenant).toBe("tenant-1");
    expect(entries[0].dlq_error).toBe("Database connection lost");
    expect(entries[0].dlq_retries).toBe(3);
    expect(entries[0].dlq_timestamp).toBeGreaterThan(0);
  });

  it("readAll returns empty array for empty DLQ", () => {
    const entries = dlq.readAll();
    expect(entries).toEqual([]);
  });

  it("count returns 0 for empty DLQ", () => {
    expect(dlq.count()).toBe(0);
  });

  it("count returns correct number of entries", () => {
    dlq.append({ ...makeEvent(), id: "e1" }, "error1", 3);
    dlq.append({ ...makeEvent(), id: "e2" }, "error2", 3);

    expect(dlq.count()).toBe(2);
  });

  it("preserves all DLQ entries across multiple appends", () => {
    for (let i = 0; i < 10; i++) {
      dlq.append({ ...makeEvent(), id: `e-${i}` }, `error-${i}`, i + 1);
    }

    const entries = dlq.readAll();
    expect(entries).toHaveLength(10);
    expect(entries[0].dlq_retries).toBe(1);
    expect(entries[9].dlq_retries).toBe(10);
  });
});
