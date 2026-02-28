import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { AuditLogger } from "./logger.js";
import { auditLog as auditMiddleware, extractResourceType } from "./middleware.js";
import type { AuditEnv } from "./types.js";

describe("extractResourceType", () => {
  it("extracts instance from path", () => {
    expect(extractResourceType("/api/instance/123")).toBe("instance");
  });

  it("extracts plugin from path", () => {
    expect(extractResourceType("/api/plugin/abc")).toBe("plugin");
  });

  it("extracts api_key from path", () => {
    expect(extractResourceType("/api/key/xyz")).toBe("api_key");
  });

  it("extracts user from /user path", () => {
    expect(extractResourceType("/api/user/settings")).toBe("user");
  });

  it("extracts user from /auth path", () => {
    expect(extractResourceType("/api/auth/login")).toBe("user");
  });

  it("extracts config from path", () => {
    expect(extractResourceType("/api/config/general")).toBe("config");
  });

  it("extracts tier from path", () => {
    expect(extractResourceType("/api/tier/upgrade")).toBe("tier");
  });

  it("defaults to instance for unknown paths", () => {
    expect(extractResourceType("/api/unknown/route")).toBe("instance");
  });
});

describe("auditLog middleware", () => {
  it("logs audit entry after successful response", async () => {
    const mockLog = vi.fn();
    const mockLogger = { log: mockLog } as unknown as AuditLogger;

    const app = new Hono<AuditEnv>();
    app.use("/*", async (c, next) => {
      c.set("user", { id: "user-1" });
      c.set("authMethod", "session");
      return next();
    });
    app.get("/api/instance/:id", auditMiddleware(mockLogger, "instance.create"), (c) => {
      return c.json({ ok: true });
    });

    const res = await app.request("/api/instance/bot-1", {
      headers: {
        "x-forwarded-for": "192.168.1.1, 10.0.0.1",
        "user-agent": "TestBrowser/1.0",
      },
    });

    expect(res.status).toBe(200);
    expect(mockLog).toHaveBeenCalledOnce();
    expect(mockLog).toHaveBeenCalledWith({
      userId: "user-1",
      authMethod: "session",
      action: "instance.create",
      resourceType: "instance",
      resourceId: "bot-1",
      ipAddress: null,
      userAgent: "TestBrowser/1.0",
    });
  });

  it("does not log when response is not ok (e.g., 400)", async () => {
    const mockLog = vi.fn();
    const mockLogger = { log: mockLog } as unknown as AuditLogger;

    const app = new Hono<AuditEnv>();
    app.use("/*", async (c, next) => {
      c.set("user", { id: "user-1" });
      c.set("authMethod", "session");
      return next();
    });
    app.get("/api/instance", auditMiddleware(mockLogger, "instance.create"), (c) => {
      return c.json({ error: "Bad request" }, 400);
    });

    const res = await app.request("/api/instance");
    expect(res.status).toBe(400);
    expect(mockLog).not.toHaveBeenCalled();
  });

  it("does not log when no user is set (unauthenticated route)", async () => {
    const mockLog = vi.fn();
    const mockLogger = { log: mockLog } as unknown as AuditLogger;

    const app = new Hono<AuditEnv>();
    app.get("/api/public", auditMiddleware(mockLogger, "auth.login"), (c) => {
      return c.json({ ok: true });
    });

    const res = await app.request("/api/public");
    expect(res.status).toBe(200);
    expect(mockLog).not.toHaveBeenCalled();
  });

  it("does not break the request if logger.log throws", async () => {
    const mockLog = vi.fn().mockImplementation(() => {
      throw new Error("DB write failed");
    });
    const mockLogger = { log: mockLog } as unknown as AuditLogger;

    const app = new Hono<AuditEnv>();
    app.use("/*", async (c, next) => {
      c.set("user", { id: "user-1" });
      c.set("authMethod", "session");
      return next();
    });
    app.get("/api/instance", auditMiddleware(mockLogger, "instance.create"), (c) => {
      return c.json({ ok: true });
    });

    const res = await app.request("/api/instance");
    expect(res.status).toBe(200);
  });

  it("defaults authMethod to session when not set", async () => {
    const mockLog = vi.fn();
    const mockLogger = { log: mockLog } as unknown as AuditLogger;

    const app = new Hono<AuditEnv>();
    app.use("/*", async (c, next) => {
      c.set("user", { id: "user-1" });
      // Deliberately NOT setting authMethod
      return next();
    });
    app.get("/api/instance", auditMiddleware(mockLogger, "instance.create"), (c) => {
      return c.json({ ok: true });
    });

    const res = await app.request("/api/instance");
    expect(res.status).toBe(200);
    expect(mockLog).toHaveBeenCalledOnce();
    expect(mockLog.mock.calls[0][0].authMethod).toBe("session");
  });
});
