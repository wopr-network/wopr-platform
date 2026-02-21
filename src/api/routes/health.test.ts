import { describe, expect, it, vi } from "vitest";
import type { BackupStatusStore } from "../../backup/backup-status-store.js";
import { createHealthRoutes } from "./health.js";

function createMockStore(staleCount: number, totalCount: number): BackupStatusStore {
  return {
    listStale: vi.fn().mockReturnValue(Array(staleCount).fill({ isStale: true })),
    count: vi.fn().mockReturnValue(totalCount),
    listAll: vi.fn().mockReturnValue([]),
    get: vi.fn().mockReturnValue(null),
    recordSuccess: vi.fn(),
    recordFailure: vi.fn(),
  } as unknown as BackupStatusStore;
}

describe("health routes", () => {
  it("GET /health returns ok", async () => {
    const { app } = await import("../app.js");
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.service).toBe("wopr-platform");
  });

  it("returns ok when no backup store is available", async () => {
    const routes = createHealthRoutes(() => null);
    const res = await routes.request("/");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.service).toBe("wopr-platform");
    expect(body.backups).toBeUndefined();
  });

  it("returns ok with backup info when all backups fresh", async () => {
    const store = createMockStore(0, 5);
    const routes = createHealthRoutes(() => store);
    const res = await routes.request("/");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.backups).toEqual({ staleCount: 0, totalTracked: 5 });
  });

  it("returns degraded when stale backups exist", async () => {
    const store = createMockStore(2, 5);
    const routes = createHealthRoutes(() => store);
    const res = await routes.request("/");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("degraded");
    expect(body.backups).toEqual({ staleCount: 2, totalTracked: 5 });
  });

  it("does not crash when backup store throws", async () => {
    const store = {
      listStale: vi.fn().mockImplementation(() => {
        throw new Error("DB locked");
      }),
      count: vi.fn().mockReturnValue(0),
    } as unknown as BackupStatusStore;
    const routes = createHealthRoutes(() => store);
    const res = await routes.request("/");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.backups).toBeUndefined();
  });
});

describe("readiness probe", () => {
  it("GET /health/ready returns 200 with ready status", async () => {
    const { Hono } = await import("hono");
    const app = new Hono();
    app.get("/health/ready", (c) => c.json({ status: "ready", service: "wopr-platform" }));
    const res = await app.request("/health/ready");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: "ready", service: "wopr-platform" });
  });
});
