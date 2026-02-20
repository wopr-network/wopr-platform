import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyPlatformPragmas } from "./pragmas.js";

describe("applyPlatformPragmas", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pragmas-test-"));
    dbPath = join(tmpDir, "test.db");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("sets WAL journal mode on a file-based database", () => {
    const db = new Database(dbPath);
    applyPlatformPragmas(db);
    const result = db.pragma("journal_mode");
    db.close();
    expect(result).toEqual([{ journal_mode: "wal" }]);
  });

  it("sets busy_timeout to 5000ms", () => {
    const db = new Database(dbPath);
    applyPlatformPragmas(db);
    // better-sqlite3 returns the timeout pragma with key "timeout", not "busy_timeout"
    const result = db.pragma("busy_timeout");
    db.close();
    expect(result).toEqual([{ timeout: 5000 }]);
  });
});
