import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuditEnv } from "../../audit/types.js";
import { activityRoutes, setActivityDb } from "./activity.js";

// Build a test app with session user already injected
function makeApp(user: { id: string; roles: string[] } | null = { id: "user-123", roles: ["user"] }) {
  const app = new Hono<AuditEnv>();
  app.use("/*", async (c, next) => {
    if (user) {
      c.set("user", user);
    }
    return next();
  });
  app.route("/api/activity", activityRoutes);
  return app;
}

// Mock DB factory — mimics the Drizzle chain that queryAuditLog() calls internally
function makeMockDb(rows: Record<string, unknown>[]) {
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockReturnValue({
            limit: vi.fn().mockReturnValue({
              offset: vi.fn().mockReturnValue({
                all: vi.fn().mockReturnValue(rows),
              }),
            }),
          }),
        }),
      }),
    }),
  };
}

beforeEach(() => {
  setActivityDb(null);
});

describe("GET /api/activity", () => {
  it("returns 401 when no user session", async () => {
    const app = makeApp(null);
    const res = await app.request("/api/activity");
    expect(res.status).toBe(401);
  });

  it("returns empty array when no audit entries", async () => {
    const mockDb = makeMockDb([]);
    setActivityDb(mockDb as unknown as ReturnType<typeof import("../../db/index.js").createDb>);

    const app = makeApp();
    const res = await app.request("/api/activity");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
  });

  it("returns formatted activity events from audit_log", async () => {
    const now = Date.now();
    const mockDb = makeMockDb([
      {
        id: "evt-1",
        timestamp: now,
        userId: "user-123",
        action: "instance.start",
        resourceType: "instance",
        resourceId: "bot-abc",
        authMethod: "session",
        details: null,
        ipAddress: null,
        userAgent: null,
      },
    ]);
    setActivityDb(mockDb as unknown as ReturnType<typeof import("../../db/index.js").createDb>);

    const app = makeApp();
    const res = await app.request("/api/activity");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      timestamp: string;
      actor: string;
      action: string;
      target: string;
      targetHref: string;
    }[];
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe("evt-1");
    expect(body[0].actor).toBe("user-123");
    expect(body[0].action).toBe("Started instance");
    expect(body[0].target).toBe("bot-abc");
    expect(body[0].targetHref).toBe("/instances/bot-abc");
    // Verify timestamp is ISO-8601
    expect(body[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("respects ?limit= query param", async () => {
    const limitSpy = vi.fn().mockReturnValue({
      offset: vi.fn().mockReturnValue({
        all: vi.fn().mockReturnValue([]),
      }),
    });
    const mockDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: limitSpy,
            }),
          }),
        }),
      }),
    };
    setActivityDb(mockDb as unknown as ReturnType<typeof import("../../db/index.js").createDb>);

    const app = makeApp();
    await app.request("/api/activity?limit=5");
    expect(limitSpy).toHaveBeenCalledWith(5);
  });

  it("clamps limit to 100 maximum", async () => {
    const limitSpy = vi.fn().mockReturnValue({
      offset: vi.fn().mockReturnValue({
        all: vi.fn().mockReturnValue([]),
      }),
    });
    const mockDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: limitSpy,
            }),
          }),
        }),
      }),
    };
    setActivityDb(mockDb as unknown as ReturnType<typeof import("../../db/index.js").createDb>);

    const app = makeApp();
    await app.request("/api/activity?limit=999");
    expect(limitSpy).toHaveBeenCalledWith(100);
  });

  it("defaults limit to 20 when not specified", async () => {
    const limitSpy = vi.fn().mockReturnValue({
      offset: vi.fn().mockReturnValue({
        all: vi.fn().mockReturnValue([]),
      }),
    });
    const mockDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: limitSpy,
            }),
          }),
        }),
      }),
    };
    setActivityDb(mockDb as unknown as ReturnType<typeof import("../../db/index.js").createDb>);

    const app = makeApp();
    await app.request("/api/activity");
    expect(limitSpy).toHaveBeenCalledWith(20);
  });
});

describe("formatAction helper", () => {
  it("formats instance.start as Started instance", async () => {
    const now = Date.now();
    const mockDb = makeMockDb([
      {
        id: "1",
        timestamp: now,
        userId: "user-123",
        action: "instance.start",
        resourceType: "instance",
        resourceId: "bot-1",
        authMethod: "session",
        details: null,
        ipAddress: null,
        userAgent: null,
      },
    ]);
    setActivityDb(mockDb as unknown as ReturnType<typeof import("../../db/index.js").createDb>);

    const app = makeApp();
    const res = await app.request("/api/activity");
    const body = (await res.json()) as { action: string }[];
    expect(body[0].action).toBe("Started instance");
  });

  it("formats key.create as Created key", async () => {
    const now = Date.now();
    const mockDb = makeMockDb([
      {
        id: "2",
        timestamp: now,
        userId: "user-123",
        action: "key.create",
        resourceType: "key",
        resourceId: "key-1",
        authMethod: "session",
        details: null,
        ipAddress: null,
        userAgent: null,
      },
    ]);
    setActivityDb(mockDb as unknown as ReturnType<typeof import("../../db/index.js").createDb>);

    const app = makeApp();
    const res = await app.request("/api/activity");
    const body = (await res.json()) as { action: string }[];
    expect(body[0].action).toBe("Created key");
  });
});

describe("buildTargetHref helper", () => {
  it("routes instance resource to /instances/:id", async () => {
    const now = Date.now();
    const mockDb = makeMockDb([
      {
        id: "3",
        timestamp: now,
        userId: "user-123",
        action: "instance.stop",
        resourceType: "instance",
        resourceId: "bot-xyz",
        authMethod: "session",
        details: null,
        ipAddress: null,
        userAgent: null,
      },
    ]);
    setActivityDb(mockDb as unknown as ReturnType<typeof import("../../db/index.js").createDb>);

    const app = makeApp();
    const res = await app.request("/api/activity");
    const body = (await res.json()) as { targetHref: string }[];
    expect(body[0].targetHref).toBe("/instances/bot-xyz");
  });

  it("routes key resource to /settings", async () => {
    const now = Date.now();
    const mockDb = makeMockDb([
      {
        id: "4",
        timestamp: now,
        userId: "user-123",
        action: "key.delete",
        resourceType: "key",
        resourceId: "key-1",
        authMethod: "session",
        details: null,
        ipAddress: null,
        userAgent: null,
      },
    ]);
    setActivityDb(mockDb as unknown as ReturnType<typeof import("../../db/index.js").createDb>);

    const app = makeApp();
    const res = await app.request("/api/activity");
    const body = (await res.json()) as { targetHref: string }[];
    expect(body[0].targetHref).toBe("/settings");
  });

  it("falls back to /dashboard for unknown resource types", async () => {
    const now = Date.now();
    const mockDb = makeMockDb([
      {
        id: "5",
        timestamp: now,
        userId: "user-123",
        action: "unknown.action",
        resourceType: "unknown-type",
        resourceId: null,
        authMethod: "session",
        details: null,
        ipAddress: null,
        userAgent: null,
      },
    ]);
    setActivityDb(mockDb as unknown as ReturnType<typeof import("../../db/index.js").createDb>);

    const app = makeApp();
    const res = await app.request("/api/activity");
    const body = (await res.json()) as { targetHref: string; target: string }[];
    expect(body[0].targetHref).toBe("/dashboard");
    // target falls back to resourceType when resourceId is null
    expect(body[0].target).toBe("unknown-type");
  });
});
