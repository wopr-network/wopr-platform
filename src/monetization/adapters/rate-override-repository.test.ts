import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DrizzleDb } from "../../db/index.js";
import { createTestDb, truncateAllTables } from "../../test/db.js";
import type { IAdapterRateOverrideRepository } from "./rate-override-repository.js";
import { AdapterRateOverrideCache, DrizzleAdapterRateOverrideRepository } from "./rate-override-repository.js";

describe("DrizzleAdapterRateOverrideRepository", () => {
  let pool: PGlite;
  let db: DrizzleDb;
  let repo: DrizzleAdapterRateOverrideRepository;

  const baseInput = {
    adapterId: "openai",
    name: "Summer Sale",
    discountPercent: 20,
    startsAt: new Date("2025-06-01T00:00:00Z"),
    endsAt: null as Date | null,
    status: "active" as const,
    createdBy: "admin-1",
    notes: null as string | null,
  };

  beforeAll(async () => {
    ({ db, pool } = await createTestDb());
  });

  afterAll(async () => {
    await pool.close();
  });

  beforeEach(async () => {
    await truncateAllTables(pool);
    repo = new DrizzleAdapterRateOverrideRepository(db);
  });

  describe("findActiveForAdapter", () => {
    it("returns null when no active override exists", async () => {
      const result = await repo.findActiveForAdapter("openai");
      expect(result).toBeNull();
    });

    it("returns the active override within the window", async () => {
      const past = new Date("2025-01-01T00:00:00Z");
      const future = new Date("2030-12-31T00:00:00Z");
      const now = new Date("2025-06-15T00:00:00Z");
      await repo.create({ ...baseInput, startsAt: past, endsAt: future, status: "active" });
      const result = await repo.findActiveForAdapter("openai", now);
      expect(result).not.toBeNull();
      expect(result?.discountPercent).toBe(20);
    });

    it("ignores expired overrides (ends_at in the past)", async () => {
      const past = new Date("2020-01-01T00:00:00Z");
      const expiredEnd = new Date("2021-01-01T00:00:00Z");
      const now = new Date("2025-06-15T00:00:00Z");
      await repo.create({ ...baseInput, startsAt: past, endsAt: expiredEnd, status: "active" });
      const result = await repo.findActiveForAdapter("openai", now);
      expect(result).toBeNull();
    });

    it("ignores future overrides (starts_at in the future)", async () => {
      const future = new Date("2030-01-01T00:00:00Z");
      const now = new Date("2025-06-15T00:00:00Z");
      await repo.create({ ...baseInput, startsAt: future, endsAt: null, status: "active" });
      const result = await repo.findActiveForAdapter("openai", now);
      expect(result).toBeNull();
    });
  });
});

describe("AdapterRateOverrideCache", () => {
  it("returns 0 when no active override", async () => {
    const mockRepo: IAdapterRateOverrideRepository = {
      create: vi.fn(),
      getById: vi.fn(),
      list: vi.fn(),
      findActiveForAdapter: vi.fn().mockResolvedValue(null),
      updateStatus: vi.fn(),
    };
    const cache = new AdapterRateOverrideCache(mockRepo);
    const result = await cache.getDiscountPercent("openai");
    expect(result).toBe(0);
  });

  it("caches the result — repo only called once for two calls within TTL", async () => {
    const findFn = vi.fn().mockResolvedValue({ discountPercent: 15 });
    const mockRepo: IAdapterRateOverrideRepository = {
      create: vi.fn(),
      getById: vi.fn(),
      list: vi.fn(),
      findActiveForAdapter: findFn,
      updateStatus: vi.fn(),
    };
    const cache = new AdapterRateOverrideCache(mockRepo);
    await cache.getDiscountPercent("openai");
    await cache.getDiscountPercent("openai");
    expect(findFn).toHaveBeenCalledTimes(1);
  });

  it("re-fetches after invalidate", async () => {
    const findFn = vi.fn().mockResolvedValue({ discountPercent: 10 });
    const mockRepo: IAdapterRateOverrideRepository = {
      create: vi.fn(),
      getById: vi.fn(),
      list: vi.fn(),
      findActiveForAdapter: findFn,
      updateStatus: vi.fn(),
    };
    const cache = new AdapterRateOverrideCache(mockRepo);
    await cache.getDiscountPercent("openai");
    cache.invalidate("openai");
    await cache.getDiscountPercent("openai");
    expect(findFn).toHaveBeenCalledTimes(2);
  });
});
