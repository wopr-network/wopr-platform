import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import {
  buildTokenMap,
  parseTokenScope,
  scopeSatisfies,
  scopedBearerAuth,
  type TokenScope,
} from "./index.js";

// ---------------------------------------------------------------------------
// parseTokenScope
// ---------------------------------------------------------------------------

describe("parseTokenScope", () => {
  it("parses read scope from wopr_read_<random>", () => {
    expect(parseTokenScope("wopr_read_abc123")).toBe("read");
  });

  it("parses write scope from wopr_write_<random>", () => {
    expect(parseTokenScope("wopr_write_xyz789")).toBe("write");
  });

  it("parses admin scope from wopr_admin_<random>", () => {
    expect(parseTokenScope("wopr_admin_secret42")).toBe("admin");
  });

  it("handles tokens with underscores in the random part", () => {
    expect(parseTokenScope("wopr_read_abc_def_ghi")).toBe("read");
  });

  it("returns null for tokens without wopr_ prefix", () => {
    expect(parseTokenScope("some-plain-token")).toBeNull();
    expect(parseTokenScope("fleet-token-123")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseTokenScope("")).toBeNull();
  });

  it("returns null for wopr_ with no scope", () => {
    expect(parseTokenScope("wopr_")).toBeNull();
  });

  it("returns null for wopr_ with invalid scope", () => {
    expect(parseTokenScope("wopr_superadmin_abc")).toBeNull();
    expect(parseTokenScope("wopr_delete_abc")).toBeNull();
    expect(parseTokenScope("wopr_root_abc")).toBeNull();
  });

  it("returns null for wopr_ with scope but no random part", () => {
    expect(parseTokenScope("wopr_read_")).toBeNull();
    expect(parseTokenScope("wopr_read")).toBeNull();
  });

  it("returns null for partial prefix", () => {
    expect(parseTokenScope("wop_read_abc")).toBeNull();
    expect(parseTokenScope("WOPR_read_abc")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// scopeSatisfies
// ---------------------------------------------------------------------------

describe("scopeSatisfies", () => {
  it("read satisfies read", () => {
    expect(scopeSatisfies("read", "read")).toBe(true);
  });

  it("write satisfies read", () => {
    expect(scopeSatisfies("write", "read")).toBe(true);
  });

  it("write satisfies write", () => {
    expect(scopeSatisfies("write", "write")).toBe(true);
  });

  it("admin satisfies read", () => {
    expect(scopeSatisfies("admin", "read")).toBe(true);
  });

  it("admin satisfies write", () => {
    expect(scopeSatisfies("admin", "write")).toBe(true);
  });

  it("admin satisfies admin", () => {
    expect(scopeSatisfies("admin", "admin")).toBe(true);
  });

  it("read does NOT satisfy write", () => {
    expect(scopeSatisfies("read", "write")).toBe(false);
  });

  it("read does NOT satisfy admin", () => {
    expect(scopeSatisfies("read", "admin")).toBe(false);
  });

  it("write does NOT satisfy admin", () => {
    expect(scopeSatisfies("write", "admin")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildTokenMap
// ---------------------------------------------------------------------------

describe("buildTokenMap", () => {
  it("maps FLEET_API_TOKEN as admin (backwards compat)", () => {
    const map = buildTokenMap({ FLEET_API_TOKEN: "legacy-token" });
    expect(map.get("legacy-token")).toBe("admin");
  });

  it("maps scoped env vars to correct scopes", () => {
    const map = buildTokenMap({
      FLEET_API_TOKEN_READ: "wopr_read_r1",
      FLEET_API_TOKEN_WRITE: "wopr_write_w1",
      FLEET_API_TOKEN_ADMIN: "wopr_admin_a1",
    });
    expect(map.get("wopr_read_r1")).toBe("read");
    expect(map.get("wopr_write_w1")).toBe("write");
    expect(map.get("wopr_admin_a1")).toBe("admin");
  });

  it("scoped vars take priority over legacy token", () => {
    const token = "shared-token";
    const map = buildTokenMap({
      FLEET_API_TOKEN: token,
      FLEET_API_TOKEN_READ: token,
    });
    // The scoped var should have set it to read first
    expect(map.get(token)).toBe("read");
  });

  it("returns empty map when no env vars set", () => {
    const map = buildTokenMap({});
    expect(map.size).toBe(0);
  });

  it("infers scope from wopr_ format for legacy token", () => {
    const map = buildTokenMap({ FLEET_API_TOKEN: "wopr_read_abc123" });
    expect(map.get("wopr_read_abc123")).toBe("read");
  });

  it("supports all scoped vars alongside legacy", () => {
    const map = buildTokenMap({
      FLEET_API_TOKEN: "legacy-admin",
      FLEET_API_TOKEN_READ: "read-token",
      FLEET_API_TOKEN_WRITE: "write-token",
      FLEET_API_TOKEN_ADMIN: "admin-token",
    });
    expect(map.size).toBe(4);
    expect(map.get("legacy-admin")).toBe("admin");
    expect(map.get("read-token")).toBe("read");
    expect(map.get("write-token")).toBe("write");
    expect(map.get("admin-token")).toBe("admin");
  });
});

// ---------------------------------------------------------------------------
// scopedBearerAuth middleware
// ---------------------------------------------------------------------------

describe("scopedBearerAuth middleware", () => {
  const tokenMap = new Map<string, TokenScope>([
    ["wopr_read_r1", "read"],
    ["wopr_write_w1", "write"],
    ["wopr_admin_a1", "admin"],
    ["legacy-admin", "admin"],
  ]);

  function createApp(requiredScope: TokenScope) {
    const app = new Hono();
    app.use("/*", scopedBearerAuth(tokenMap, requiredScope));
    app.get("/test", (c) => c.json({ ok: true }));
    app.post("/test", (c) => c.json({ ok: true }));
    return app;
  }

  describe("authentication", () => {
    it("rejects request with no Authorization header", async () => {
      const app = createApp("read");
      const res = await app.request("/test");
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toBe("Authentication required");
    });

    it("rejects request with empty Authorization header", async () => {
      const app = createApp("read");
      const res = await app.request("/test", {
        headers: { Authorization: "" },
      });
      expect(res.status).toBe(401);
    });

    it("rejects request with non-Bearer scheme", async () => {
      const app = createApp("read");
      const res = await app.request("/test", {
        headers: { Authorization: "Basic abc123" },
      });
      expect(res.status).toBe(401);
    });

    it("rejects request with unknown token", async () => {
      const app = createApp("read");
      const res = await app.request("/test", {
        headers: { Authorization: "Bearer unknown-token" },
      });
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toBe("Invalid or expired token");
    });
  });

  describe("read scope routes", () => {
    const app = createApp("read");

    it("allows read token on read routes", async () => {
      const res = await app.request("/test", {
        headers: { Authorization: "Bearer wopr_read_r1" },
      });
      expect(res.status).toBe(200);
    });

    it("allows write token on read routes", async () => {
      const res = await app.request("/test", {
        headers: { Authorization: "Bearer wopr_write_w1" },
      });
      expect(res.status).toBe(200);
    });

    it("allows admin token on read routes", async () => {
      const res = await app.request("/test", {
        headers: { Authorization: "Bearer wopr_admin_a1" },
      });
      expect(res.status).toBe(200);
    });

    it("allows legacy admin token on read routes", async () => {
      const res = await app.request("/test", {
        headers: { Authorization: "Bearer legacy-admin" },
      });
      expect(res.status).toBe(200);
    });
  });

  describe("write scope routes", () => {
    const app = createApp("write");

    it("rejects read token on write routes with 403", async () => {
      const res = await app.request("/test", {
        method: "POST",
        headers: { Authorization: "Bearer wopr_read_r1" },
      });
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBe("Insufficient scope");
      expect(body.required).toBe("write");
      expect(body.provided).toBe("read");
    });

    it("allows write token on write routes", async () => {
      const res = await app.request("/test", {
        method: "POST",
        headers: { Authorization: "Bearer wopr_write_w1" },
      });
      expect(res.status).toBe(200);
    });

    it("allows admin token on write routes", async () => {
      const res = await app.request("/test", {
        method: "POST",
        headers: { Authorization: "Bearer wopr_admin_a1" },
      });
      expect(res.status).toBe(200);
    });
  });

  describe("admin scope routes", () => {
    const app = createApp("admin");

    it("rejects read token on admin routes with 403", async () => {
      const res = await app.request("/test", {
        headers: { Authorization: "Bearer wopr_read_r1" },
      });
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBe("Insufficient scope");
      expect(body.required).toBe("admin");
      expect(body.provided).toBe("read");
    });

    it("rejects write token on admin routes with 403", async () => {
      const res = await app.request("/test", {
        headers: { Authorization: "Bearer wopr_write_w1" },
      });
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBe("Insufficient scope");
      expect(body.required).toBe("admin");
      expect(body.provided).toBe("write");
    });

    it("allows admin token on admin routes", async () => {
      const res = await app.request("/test", {
        headers: { Authorization: "Bearer wopr_admin_a1" },
      });
      expect(res.status).toBe(200);
    });

    it("allows legacy admin token on admin routes", async () => {
      const res = await app.request("/test", {
        headers: { Authorization: "Bearer legacy-admin" },
      });
      expect(res.status).toBe(200);
    });
  });

  describe("backwards compatibility", () => {
    it("existing FLEET_API_TOKEN works as admin on all scopes", async () => {
      const legacyMap = buildTokenMap({ FLEET_API_TOKEN: "my-old-token" });

      for (const scope of ["read", "write", "admin"] as TokenScope[]) {
        const app = new Hono();
        app.use("/*", scopedBearerAuth(legacyMap, scope));
        app.get("/test", (c) => c.json({ ok: true }));

        const res = await app.request("/test", {
          headers: { Authorization: "Bearer my-old-token" },
        });
        expect(res.status).toBe(200);
      }
    });
  });

  describe("empty token map", () => {
    it("rejects all tokens when map is empty", async () => {
      const emptyMap = new Map<string, TokenScope>();
      const app = new Hono();
      app.use("/*", scopedBearerAuth(emptyMap, "read"));
      app.get("/test", (c) => c.json({ ok: true }));

      const res = await app.request("/test", {
        headers: { Authorization: "Bearer any-token" },
      });
      expect(res.status).toBe(401);
    });
  });
});
