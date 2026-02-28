import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../test/db.js";
import { DrizzleSpendingLimitsRepository } from "./drizzle-spending-limits-repository.js";

describe("DrizzleSpendingLimitsRepository", () => {
  let pool: PGlite;
  let repo: DrizzleSpendingLimitsRepository;

  beforeEach(async () => {
    const { db, pool: p } = await createTestDb();
    pool = p;
    repo = new DrizzleSpendingLimitsRepository(db);
  });

  afterEach(async () => {
    await pool.close();
  });

  it("get() returns defaults when tenant has no row", async () => {
    const result = await repo.get("nonexistent-tenant");
    expect(result).toEqual({
      global: { alertAt: null, hardCap: null },
      perCapability: {},
    });
  });

  it("upsert() then get() round-trips correctly for global limits", async () => {
    await repo.upsert("tenant-1", {
      global: { alertAt: 50.5, hardCap: 100.0 },
      perCapability: {},
    });
    const result = await repo.get("tenant-1");
    expect(result.global.alertAt).toBeCloseTo(50.5);
    expect(result.global.hardCap).toBeCloseTo(100.0);
    expect(result.perCapability).toEqual({});
  });

  it("upsert() then get() round-trips correctly for per-capability limits", async () => {
    const data = {
      global: { alertAt: null, hardCap: null },
      perCapability: {
        tts: { alertAt: 10, hardCap: 25 },
        "image-gen": { alertAt: null, hardCap: 50 },
      },
    };
    await repo.upsert("tenant-2", data);
    const result = await repo.get("tenant-2");
    expect(result.perCapability).toEqual(data.perCapability);
    expect(result.global).toEqual({ alertAt: null, hardCap: null });
  });

  it("second upsert() on same tenant overwrites (not appends)", async () => {
    await repo.upsert("tenant-3", {
      global: { alertAt: 10, hardCap: 20 },
      perCapability: { tts: { alertAt: 5, hardCap: 10 } },
    });
    await repo.upsert("tenant-3", {
      global: { alertAt: 99, hardCap: 200 },
      perCapability: { stt: { alertAt: 1, hardCap: 2 } },
    });
    const result = await repo.get("tenant-3");
    expect(result.global.alertAt).toBeCloseTo(99);
    expect(result.global.hardCap).toBeCloseTo(200);
    // Old per-capability key "tts" must be gone — overwrite, not merge
    expect(result.perCapability).toEqual({ stt: { alertAt: 1, hardCap: 2 } });
  });

  it("get() returns empty perCapability when perCapabilityJson is malformed JSON", async () => {
    // Insert directly via raw SQL to bypass repo's JSON.stringify
    await pool.query(
      `INSERT INTO tenant_spending_limits (tenant_id, global_alert_at, global_hard_cap, per_capability_json, updated_at)
       VALUES ($1, $2, $3, $4, $5)`,
      ["tenant-bad-json", 10, 20, "not-valid-json{{{", Date.now()],
    );
    const result = await repo.get("tenant-bad-json");
    expect(result.global.alertAt).toBeCloseTo(10);
    expect(result.global.hardCap).toBeCloseTo(20);
    expect(result.perCapability).toEqual({});
  });

  it("get() returns null alertAt/hardCap when limits are null", async () => {
    await repo.upsert("tenant-nulls", {
      global: { alertAt: null, hardCap: null },
      perCapability: {},
    });
    const result = await repo.get("tenant-nulls");
    expect(result.global.alertAt).toBeNull();
    expect(result.global.hardCap).toBeNull();
    expect(result.perCapability).toEqual({});
  });
});
