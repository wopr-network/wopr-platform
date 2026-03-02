import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { type GatewayAuthEnv, serviceKeyAuth } from "./service-key-auth.js";
import type { GatewayTenant } from "./types.js";

const TEST_TENANT: GatewayTenant = {
  id: "tenant-abc",
  spendLimits: { maxSpendPerHour: null, maxSpendPerMonth: null },
};

function buildTestApp(resolveServiceKey: (key: string) => GatewayTenant | null) {
  const app = new Hono<GatewayAuthEnv>();
  app.use("/*", serviceKeyAuth(resolveServiceKey));
  app.get("/protected", (c) => {
    const tenant = c.get("gatewayTenant");
    return c.json({ ok: true, tenantId: tenant.id });
  });
  return app;
}

describe("serviceKeyAuth", () => {
  const validKey = "sk-test-valid-key-1234567890";
  const resolver = (key: string): GatewayTenant | null => (key === validKey ? TEST_TENANT : null);

  describe("missing Authorization header", () => {
    it("returns 401 with missing_api_key code", async () => {
      const app = buildTestApp(resolver);
      const res = await app.request("/protected");

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body).toEqual({
        error: {
          message: "Missing Authorization header",
          type: "authentication_error",
          code: "missing_api_key",
        },
      });
    });
  });

  describe("invalid Authorization format", () => {
    it("rejects header without Bearer prefix", async () => {
      const app = buildTestApp(resolver);
      const res = await app.request("/protected", {
        headers: { Authorization: "Basic abc123" },
      });

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error.code).toBe("invalid_auth_format");
      expect(body.error.message).toContain("Expected: Bearer");
    });

    it("rejects bare token without prefix", async () => {
      const app = buildTestApp(resolver);
      const res = await app.request("/protected", {
        headers: { Authorization: validKey },
      });

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error.code).toBe("invalid_auth_format");
    });
  });

  describe("empty service key", () => {
    it("rejects Authorization header that is only 'Bearer' with no space", async () => {
      // Hono strips all trailing whitespace from header values, so "Bearer " → "Bearer".
      // The empty-key branch (code: missing_api_key) is therefore unreachable via the
      // standard HTTP client path. The invalid-format branch covers this case instead.
      const app = buildTestApp(resolver);
      const res = await app.request("/protected", {
        headers: { Authorization: "Bearer" },
      });

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error.code).toBe("invalid_auth_format");
      expect(body.error.type).toBe("authentication_error");
    });

    it("rejects 'Bearer' with trailing spaces (Hono strips to 'Bearer')", async () => {
      const app = buildTestApp(resolver);
      const res = await app.request("/protected", {
        headers: { Authorization: "Bearer    " },
      });

      expect(res.status).toBe(401);
      const body = await res.json();
      // Hono normalizes headers — trailing spaces stripped, "Bearer " → "Bearer" → invalid format
      expect(body.error.code).toBe("invalid_auth_format");
    });
  });

  describe("invalid/unknown key", () => {
    it("rejects unknown service key with invalid_api_key code", async () => {
      const app = buildTestApp(resolver);
      const res = await app.request("/protected", {
        headers: { Authorization: "Bearer sk-unknown-key-999" },
      });

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error.code).toBe("invalid_api_key");
      expect(body.error.message).toBe("Invalid or expired service key");
    });

    it("calls resolveServiceKey with the trimmed key", async () => {
      const spy = vi.fn().mockReturnValue(null);
      const app = buildTestApp(spy);
      await app.request("/protected", {
        headers: { Authorization: "Bearer  my-key-with-spaces  " },
      });

      expect(spy).toHaveBeenCalledWith("my-key-with-spaces");
    });
  });

  describe("valid key", () => {
    it("sets gatewayTenant and calls next()", async () => {
      const app = buildTestApp(resolver);
      const res = await app.request("/protected", {
        headers: { Authorization: `Bearer ${validKey}` },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ ok: true, tenantId: "tenant-abc" });
    });

    it("accepts case-insensitive Bearer prefix", async () => {
      const app = buildTestApp(resolver);

      for (const prefix of ["bearer", "BEARER", "BeArEr"]) {
        const res = await app.request("/protected", {
          headers: { Authorization: `${prefix} ${validKey}` },
        });
        expect(res.status).toBe(200);
      }
    });

    it("handles leading/trailing whitespace on Authorization header", async () => {
      const app = buildTestApp(resolver);
      const res = await app.request("/protected", {
        headers: { Authorization: `  Bearer ${validKey}  ` },
      });

      expect(res.status).toBe(200);
    });
  });
});
