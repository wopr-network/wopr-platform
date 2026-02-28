import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DrizzleDb } from "../../db/index.js";
import { createTestDb, truncateAllTables } from "../../test/db.js";
import { CapabilitySettingsStore } from "./capability-settings-store.js";

describe("CapabilitySettingsStore", () => {
  let db: DrizzleDb;
  let pool: PGlite;
  let store: CapabilitySettingsStore;

  beforeAll(async () => {
    ({ db, pool } = await createTestDb());
  });

  afterAll(async () => {
    await pool.close();
  });

  beforeEach(async () => {
    await truncateAllTables(pool);
    store = new CapabilitySettingsStore(db);
  });

  it("returns empty array for tenant with no overrides (platform defaults apply)", async () => {
    const settings = await store.listForTenant("tenant-no-overrides");
    expect(settings).toEqual([]);
  });

  it("upsert sets per-tenant override that listForTenant returns", async () => {
    await store.upsert("tenant-1", "transcription", "byok");

    const settings = await store.listForTenant("tenant-1");
    expect(settings).toHaveLength(1);
    expect(settings[0]).toMatchObject({
      tenant_id: "tenant-1",
      capability: "transcription",
      mode: "byok",
    });
    expect(settings[0].updated_at).toBeGreaterThan(0);
  });

  it("upsert can toggle mode between hosted and byok", async () => {
    await store.upsert("tenant-2", "image-gen", "byok");
    let settings = await store.listForTenant("tenant-2");
    expect(settings[0].mode).toBe("byok");

    await store.upsert("tenant-2", "image-gen", "hosted");
    settings = await store.listForTenant("tenant-2");
    expect(settings).toHaveLength(1);
    expect(settings[0].mode).toBe("hosted");
  });

  it("upsert overwrites previous mode via onConflictDoUpdate", async () => {
    await store.upsert("tenant-3", "text-gen", "hosted");
    const before = await store.listForTenant("tenant-3");
    const firstUpdatedAt = before[0].updated_at;

    // Small delay so timestamp differs
    await new Promise((r) => setTimeout(r, 5));

    await store.upsert("tenant-3", "text-gen", "byok");
    const after = await store.listForTenant("tenant-3");
    expect(after).toHaveLength(1);
    expect(after[0].mode).toBe("byok");
    expect(after[0].updated_at).toBeGreaterThanOrEqual(firstUpdatedAt);
  });

  it("tenant A overrides do not appear in tenant B list", async () => {
    await store.upsert("tenant-A", "transcription", "byok");
    await store.upsert("tenant-A", "image-gen", "byok");
    await store.upsert("tenant-B", "embeddings", "hosted");

    const settingsA = await store.listForTenant("tenant-A");
    const settingsB = await store.listForTenant("tenant-B");

    expect(settingsA).toHaveLength(2);
    expect(settingsA.every((s) => s.tenant_id === "tenant-A")).toBe(true);

    expect(settingsB).toHaveLength(1);
    expect(settingsB[0].tenant_id).toBe("tenant-B");
    expect(settingsB[0].capability).toBe("embeddings");
  });

  it("upsert changes are immediately visible in subsequent reads (no stale cache)", async () => {
    await store.upsert("tenant-C", "text-gen", "hosted");
    const read1 = await store.listForTenant("tenant-C");
    expect(read1[0].mode).toBe("hosted");

    await store.upsert("tenant-C", "text-gen", "byok");
    const read2 = await store.listForTenant("tenant-C");
    expect(read2[0].mode).toBe("byok");

    await store.upsert("tenant-C", "image-gen", "byok");
    const read3 = await store.listForTenant("tenant-C");
    expect(read3).toHaveLength(2);
  });
});
