import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { serviceKeyAuth, type GatewayAuthEnv } from "../../src/gateway/service-key-auth.js";
import type { GatewayTenant } from "../../src/gateway/types.js";

const VALID_KEY = "wopr_sk_test_abc123";
const VALID_TENANT: GatewayTenant = {
  id: "tenant-1",
  spendLimits: { maxSpendPerHour: 10, maxSpendPerMonth: 100 },
};

function resolver(key: string): GatewayTenant | null {
  return key === VALID_KEY ? VALID_TENANT : null;
}

function makeApp() {
  const app = new Hono<GatewayAuthEnv>();
  app.use("/*", serviceKeyAuth(resolver));
  app.get("/test", (c) => {
    const tenant = c.get("gatewayTenant");
    return c.json({ tenantId: tenant.id });
  });
  return app;
}

describe("serviceKeyAuth", () => {
  it("authenticates a valid service key and sets tenant", async () => {
    const app = makeApp();
    const res = await app.request("/test", {
      headers: { Authorization: `Bearer ${VALID_KEY}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tenantId).toBe("tenant-1");
  });

  it("rejects requests without Authorization header", async () => {
    const app = makeApp();
    const res = await app.request("/test");
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("missing_api_key");
  });

  it("rejects non-Bearer auth schemes", async () => {
    const app = makeApp();
    const res = await app.request("/test", {
      headers: { Authorization: "Basic dXNlcjpwYXNz" },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_auth_format");
  });

  it("rejects empty bearer token", async () => {
    const app = makeApp();
    const res = await app.request("/test", {
      headers: { Authorization: "Bearer " },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    // "Bearer " with trailing space gets trimmed to "Bearer" by the HTTP layer,
    // which fails the "bearer " startsWith check.
    expect(body.error.code).toBe("invalid_auth_format");
  });

  it("rejects invalid service key", async () => {
    const app = makeApp();
    const res = await app.request("/test", {
      headers: { Authorization: "Bearer wopr_sk_invalid_key" },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_api_key");
  });

  it("handles case-insensitive Bearer prefix", async () => {
    const app = makeApp();
    const res = await app.request("/test", {
      headers: { Authorization: `bearer ${VALID_KEY}` },
    });
    expect(res.status).toBe(200);
  });
});
