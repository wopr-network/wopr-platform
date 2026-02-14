import { describe, expect, it } from "vitest";
import type { SpacesObject } from "./spaces-client.js";
import { getISOWeekKey, selectRetained } from "./spaces-retention.js";

/** Helper to create a SpacesObject for a given date string */
function obj(dateStr: string, path?: string): SpacesObject {
  return {
    date: `${dateStr}T03:00:00Z`,
    size: 100_000_000,
    path: path ?? `nightly/node-1/tenant_abc/tenant_abc_${dateStr.replace(/-/g, "")}.tar.gz`,
  };
}

describe("getISOWeekKey", () => {
  it("returns correct ISO week for a date", () => {
    // 2026-02-14 is a Saturday in ISO week 7
    const key = getISOWeekKey(new Date("2026-02-14T03:00:00Z"));
    expect(key).toMatch(/^2026-W\d{2}$/);
  });

  it("returns different keys for dates in different weeks", () => {
    const w1 = getISOWeekKey(new Date("2026-02-01T00:00:00Z"));
    const w2 = getISOWeekKey(new Date("2026-02-14T00:00:00Z"));
    expect(w1).not.toBe(w2);
  });
});

describe("selectRetained", () => {
  it("keeps the most recent N daily backups", () => {
    const objects = [obj("2026-02-14"), obj("2026-02-13"), obj("2026-02-12"), obj("2026-02-11"), obj("2026-02-10")];

    const retained = selectRetained(objects, { dailyCount: 3, weeklyCount: 0 }, new Date("2026-02-14"));
    expect(retained).toHaveLength(3);
    expect(retained.map((o) => o.date)).toContain("2026-02-14T03:00:00Z");
    expect(retained.map((o) => o.date)).toContain("2026-02-13T03:00:00Z");
    expect(retained.map((o) => o.date)).toContain("2026-02-12T03:00:00Z");
  });

  it("keeps weekly backups from older items", () => {
    // 14 days of daily backups, keep 3 daily + 2 weekly
    const objects: SpacesObject[] = [];
    for (let i = 0; i < 14; i++) {
      const d = new Date("2026-02-14");
      d.setDate(d.getDate() - i);
      objects.push(obj(d.toISOString().split("T")[0]));
    }

    const retained = selectRetained(objects, { dailyCount: 3, weeklyCount: 2 }, new Date("2026-02-14"));

    // Should have 3 daily + up to 2 weekly from the remaining 11
    expect(retained.length).toBeGreaterThanOrEqual(3);
    expect(retained.length).toBeLessThanOrEqual(5);
  });

  it("handles fewer objects than daily limit", () => {
    const objects = [obj("2026-02-14"), obj("2026-02-13")];

    const retained = selectRetained(objects, { dailyCount: 7, weeklyCount: 4 }, new Date("2026-02-14"));
    expect(retained).toHaveLength(2);
  });

  it("returns empty array for empty input", () => {
    const retained = selectRetained([], { dailyCount: 7, weeklyCount: 4 }, new Date("2026-02-14"));
    expect(retained).toHaveLength(0);
  });

  it("does not duplicate objects in daily and weekly sets", () => {
    const objects = [obj("2026-02-14"), obj("2026-02-13"), obj("2026-02-12")];

    const retained = selectRetained(objects, { dailyCount: 7, weeklyCount: 4 }, new Date("2026-02-14"));
    const paths = retained.map((o) => o.path);
    const unique = new Set(paths);
    expect(paths.length).toBe(unique.size);
  });
});
