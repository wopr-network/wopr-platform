import type { Pool, QueryResult } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BetterAuthLoginHistoryRepository } from "./login-history-repository.js";

function makePool(rows: Record<string, unknown>[]): Pool {
  return {
    query: vi.fn().mockResolvedValue({ rows } as unknown as QueryResult),
  } as unknown as Pool;
}

describe("BetterAuthLoginHistoryRepository", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty array when user has no sessions", async () => {
    const pool = makePool([]);
    const repo = new BetterAuthLoginHistoryRepository(pool);
    const result = await repo.findByUserId("no-such-user");
    expect(result).toEqual([]);
  });

  it("returns sessions ordered by createdAt DESC", async () => {
    const pool = makePool([
      { ipAddress: "5.6.7.8", userAgent: "Chrome/120", createdAt: new Date("2026-01-02") },
      { ipAddress: "1.2.3.4", userAgent: "Mozilla/5.0", createdAt: new Date("2026-01-01") },
    ]);
    const repo = new BetterAuthLoginHistoryRepository(pool);
    const result = await repo.findByUserId("user-1");
    expect(result).toHaveLength(2);
    expect(result[0].ip).toBe("5.6.7.8");
    expect(result[1].ip).toBe("1.2.3.4");
  });

  it("respects the limit parameter", async () => {
    const pool = makePool([
      { ipAddress: "1.1.1.1", userAgent: null, createdAt: new Date() },
      { ipAddress: "2.2.2.2", userAgent: null, createdAt: new Date() },
      { ipAddress: "3.3.3.3", userAgent: null, createdAt: new Date() },
    ]);
    const repo = new BetterAuthLoginHistoryRepository(pool);
    const result = await repo.findByUserId("user-1", 3);
    expect(pool.query).toHaveBeenCalledWith(expect.any(String), ["user-1", 3]);
    expect(result).toHaveLength(3);
  });

  it("does not return sessions for other users", async () => {
    const pool = makePool([]);
    const repo = new BetterAuthLoginHistoryRepository(pool);
    const result = await repo.findByUserId("user-1");
    expect(result).toEqual([]);
    expect(pool.query).toHaveBeenCalledWith(expect.any(String), ["user-1", 20]);
  });
});
