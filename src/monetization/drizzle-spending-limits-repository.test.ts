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

  it("limits are tenant-isolated — one tenant's limits do not affect another", async () => {
    await repo.upsert("tenant-a", {
      global: { alertAt: 10, hardCap: 50 },
      perCapability: { tts: { alertAt: 5, hardCap: 20 } },
    });
    await repo.upsert("tenant-b", {
      global: { alertAt: 100, hardCap: 500 },
      perCapability: { "image-gen": { alertAt: 30, hardCap: 100 } },
    });

    const a = await repo.get("tenant-a");
    const b = await repo.get("tenant-b");

    // Tenant A has its own limits
    expect(a.global.alertAt).toBeCloseTo(10);
    expect(a.global.hardCap).toBeCloseTo(50);
    expect(a.perCapability).toEqual({ tts: { alertAt: 5, hardCap: 20 } });

    // Tenant B has its own limits, unaffected by A
    expect(b.global.alertAt).toBeCloseTo(100);
    expect(b.global.hardCap).toBeCloseTo(500);
    expect(b.perCapability).toEqual({ "image-gen": { alertAt: 30, hardCap: 100 } });

    // Updating tenant A does not affect tenant B
    await repo.upsert("tenant-a", {
      global: { alertAt: 999, hardCap: 999 },
      perCapability: {},
    });
    const bAfter = await repo.get("tenant-b");
    expect(bAfter.global.alertAt).toBeCloseTo(100);
    expect(bAfter.global.hardCap).toBeCloseTo(500);
    expect(bAfter.perCapability).toEqual({ "image-gen": { alertAt: 30, hardCap: 100 } });
  });

  it("stored limits enable enforcement — hardCap comparison identifies over-limit tenants", async () => {
    await repo.upsert("tenant-enforced", {
      global: { alertAt: 80, hardCap: 100 },
      perCapability: { tts: { alertAt: 40, hardCap: 50 } },
    });

    const limits = await repo.get("tenant-enforced");

    // Simulate enforcement: current spend vs stored limits
    const currentGlobalSpend = 120;
    const currentTtsSpend = 45;

    // Global hard cap exceeded
    expect(currentGlobalSpend).toBeGreaterThan(limits.global.hardCap ?? 0);

    // Global alert threshold exceeded
    expect(currentGlobalSpend).toBeGreaterThan(limits.global.alertAt ?? 0);

    // Per-capability: TTS alert exceeded but hard cap not exceeded
    expect(currentTtsSpend).toBeGreaterThan(limits.perCapability.tts?.alertAt ?? 0);
    expect(currentTtsSpend).toBeLessThan(limits.perCapability.tts?.hardCap ?? Number.POSITIVE_INFINITY);

    // Tenant with no limits — enforcement should be permissive (nulls)
    const noLimits = await repo.get("tenant-no-limits");
    expect(noLimits.global.hardCap).toBeNull();
    expect(noLimits.global.alertAt).toBeNull();
  });
});
