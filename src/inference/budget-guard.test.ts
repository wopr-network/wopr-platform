import { describe, expect, it, vi } from "vitest";
import { checkSessionBudget } from "./budget-guard.js";
import type { ISessionUsageRepository } from "./session-usage-repository.js";

function mockRepo(costBySession: number): ISessionUsageRepository {
  return {
    insert: vi.fn(),
    findBySessionId: vi.fn(),
    sumCostByUser: vi.fn(),
    sumCostBySession: vi.fn().mockResolvedValue(costBySession),
    aggregateByDay: vi.fn(),
    aggregateByPage: vi.fn(),
    cacheHitRate: vi.fn(),
  };
}

describe("checkSessionBudget", () => {
  it("allows when under budget", async () => {
    const result = await checkSessionBudget(mockRepo(0.05), "sess-1", "anonymous");
    expect(result.allowed).toBe(true);
    expect(result.remainingUsd).toBeCloseTo(0.05);
  });

  it("rejects when over anonymous cap ($0.10)", async () => {
    const result = await checkSessionBudget(mockRepo(0.11), "sess-1", "anonymous");
    expect(result.allowed).toBe(false);
  });

  it("uses higher cap for authenticated free tier ($0.25)", async () => {
    const result = await checkSessionBudget(mockRepo(0.2), "sess-1", "free");
    expect(result.allowed).toBe(true);
  });

  it("uses highest cap for paid users ($1.00)", async () => {
    const result = await checkSessionBudget(mockRepo(0.9), "sess-1", "paid");
    expect(result.allowed).toBe(true);
  });

  it("rejects when exactly at anonymous cap ($0.10)", async () => {
    const result = await checkSessionBudget(mockRepo(0.1), "sess-1", "anonymous");
    expect(result.allowed).toBe(false);
    expect(result.remainingUsd).toBeCloseTo(0);
    expect(result.capUsd).toBe(0.1);
  });

  it("rejects when exactly at free tier cap ($0.25)", async () => {
    const result = await checkSessionBudget(mockRepo(0.25), "sess-1", "free");
    expect(result.allowed).toBe(false);
    expect(result.remainingUsd).toBeCloseTo(0);
    expect(result.capUsd).toBe(0.25);
  });

  it("rejects when exactly at paid tier cap ($1.00)", async () => {
    const result = await checkSessionBudget(mockRepo(1.0), "sess-1", "paid");
    expect(result.allowed).toBe(false);
    expect(result.remainingUsd).toBeCloseTo(0);
    expect(result.capUsd).toBe(1.0);
  });
});
