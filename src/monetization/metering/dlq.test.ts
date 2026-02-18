import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MeterDLQ } from "./dlq.js";

describe("MeterDLQ", () => {
  let tmpDir: string;
  let dlqPath: string;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `wopr-dlq-test-${Date.now()}`);
    dlqPath = path.join(tmpDir, "meter-dlq.jsonl");
  });

  afterEach(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("creates the directory when it does not exist", () => {
    // tmpDir doesn't exist yet — constructor should create it
    expect(existsSync(tmpDir)).toBe(false);
    new MeterDLQ(dlqPath);
    expect(existsSync(tmpDir)).toBe(true);
  });

  it("does not throw when directory already exists", () => {
    mkdirSync(tmpDir, { recursive: true });
    expect(() => new MeterDLQ(dlqPath)).not.toThrow();
  });

  it("readAll returns empty array when DLQ file does not exist", () => {
    new MeterDLQ(dlqPath);
    expect(existsSync(dlqPath)).toBe(false);
    const dlq = new MeterDLQ(dlqPath);
    expect(dlq.readAll()).toEqual([]);
  });

  it("readAll returns empty array when DLQ file is empty", () => {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(dlqPath, "");
    const dlq = new MeterDLQ(dlqPath);
    expect(dlq.readAll()).toEqual([]);
  });

  it("readAll returns empty array when DLQ file contains only whitespace", () => {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(dlqPath, "\n\n  \n");
    const dlq = new MeterDLQ(dlqPath);
    expect(dlq.readAll()).toEqual([]);
  });

  it("append writes a DLQ entry and readAll returns it", () => {
    const dlq = new MeterDLQ(dlqPath);
    const event = {
      id: "evt-1",
      tenant_id: "tenant-1",
      capability: "tts",
      units: 100,
      timestamp: Date.now(),
    };

    dlq.append(event, "Stripe API 500", 3);

    const entries = dlq.readAll();
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe("evt-1");
    expect(entries[0].dlq_error).toBe("Stripe API 500");
    expect(entries[0].dlq_retries).toBe(3);
  });

  it("count returns 0 for empty DLQ", () => {
    const dlq = new MeterDLQ(dlqPath);
    expect(dlq.count()).toBe(0);
  });

  it("count returns correct count after appending", () => {
    const dlq = new MeterDLQ(dlqPath);
    const event = { id: "evt-1", tenant_id: "t1", capability: "tts", units: 1, timestamp: Date.now() };
    dlq.append(event, "err", 1);
    dlq.append({ ...event, id: "evt-2" }, "err2", 2);
    expect(dlq.count()).toBe(2);
  });

  it("readAll skips malformed lines", () => {
    mkdirSync(tmpDir, { recursive: true });
    const goodLine = JSON.stringify({ id: "evt-1", dlq_error: "e", dlq_retries: 1, dlq_timestamp: 0 });
    writeFileSync(dlqPath, `${goodLine}\nnot-valid-json\n`);
    const dlq = new MeterDLQ(dlqPath);
    const entries = dlq.readAll();
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe("evt-1");
  });
});
