import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createFeatureGate } from "./feature-gate.js";
import type { PlanTier } from "./quotas/tier-definitions.js";
import { tierSatisfies } from "./quotas/tier-definitions.js";

// biome-ignore lint/suspicious/noExplicitAny: test helper type for flexible Hono vars
type AnyEnv = { Variables: Record<string, any> };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const freeTier: PlanTier = {
  id: "free",
  name: "free",
  maxInstances: 1,
  maxPluginsPerInstance: 5,
  memoryLimitMb: 512,
  cpuQuota: 50_000,
  storageLimitMb: 1024,
  maxProcesses: 128,
  features: [],
  maxSpendPerHour: 0.5,
  maxSpendPerMonth: 5,
};

const proTier: PlanTier = {
  id: "pro",
  name: "pro",
  maxInstances: 5,
  maxPluginsPerInstance: null,
  memoryLimitMb: 2048,
  cpuQuota: 200_000,
  storageLimitMb: 10_240,
  maxProcesses: 512,
  features: ["premium_plugins", "priority-support", "custom-domains"],
  maxSpendPerHour: 10,
  maxSpendPerMonth: 200,
};

const teamTier: PlanTier = {
  id: "team",
  name: "team",
  maxInstances: 20,
  maxPluginsPerInstance: null,
  memoryLimitMb: 4096,
  cpuQuota: 400_000,
  storageLimitMb: 51_200,
  maxProcesses: 1024,
  features: ["premium_plugins", "priority-support", "custom-domains", "team-management", "audit-logs"],
  maxSpendPerHour: 50,
  maxSpendPerMonth: 1000,
};

const enterpriseTier: PlanTier = {
  id: "enterprise",
  name: "enterprise",
  maxInstances: 0,
  maxPluginsPerInstance: null,
  memoryLimitMb: 16_384,
  cpuQuota: 800_000,
  storageLimitMb: 102_400,
  maxProcesses: 4096,
  features: [
    "premium_plugins",
    "priority-support",
    "custom-domains",
    "team-management",
    "audit-logs",
    "sso",
    "dedicated-support",
  ],
  maxSpendPerHour: null,
  maxSpendPerMonth: null,
};

const tiers: Record<string, PlanTier> = {
  "user-free": freeTier,
  "user-pro": proTier,
  "user-team": teamTier,
  "user-enterprise": enterpriseTier,
};

function getUserTier(userId: string): PlanTier {
  return tiers[userId] ?? freeTier;
}

/** Build a test Hono app with the feature gate middleware */
function buildApp(minTier: "free" | "pro" | "team" | "enterprise") {
  const { requireTier } = createFeatureGate({ getUserTier });
  const app = new Hono<AnyEnv>();

  // Simulate auth middleware that sets user on context
  app.use("/*", async (c, next) => {
    const userId = c.req.header("x-user-id");
    if (userId) {
      c.set("user", { id: userId });
    }
    return next();
  });

  app.get("/protected", requireTier(minTier), (c) => {
    const tier = c.get("tier") as PlanTier;
    return c.json({ ok: true, tier: tier.name });
  });

  return app;
}

function buildFeatureApp(feature: string) {
  const { requireTier, requireFeature } = createFeatureGate({ getUserTier });
  const app = new Hono<AnyEnv>();

  app.use("/*", async (c, next) => {
    const userId = c.req.header("x-user-id");
    if (userId) {
      c.set("user", { id: userId });
    }
    return next();
  });

  app.get("/feature", requireTier("free"), requireFeature(feature), (c) => {
    return c.json({ ok: true });
  });

  return app;
}

// ---------------------------------------------------------------------------
// tierSatisfies unit tests
// ---------------------------------------------------------------------------

describe("tierSatisfies", () => {
  it("free satisfies free", () => {
    expect(tierSatisfies("free", "free")).toBe(true);
  });

  it("pro satisfies free", () => {
    expect(tierSatisfies("pro", "free")).toBe(true);
  });

  it("free does not satisfy pro", () => {
    expect(tierSatisfies("free", "pro")).toBe(false);
  });

  it("enterprise satisfies all", () => {
    expect(tierSatisfies("enterprise", "free")).toBe(true);
    expect(tierSatisfies("enterprise", "pro")).toBe(true);
    expect(tierSatisfies("enterprise", "team")).toBe(true);
    expect(tierSatisfies("enterprise", "enterprise")).toBe(true);
  });

  it("unknown tier returns false", () => {
    expect(tierSatisfies("unknown", "free")).toBe(false);
    expect(tierSatisfies("free", "unknown")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// requireTier middleware
// ---------------------------------------------------------------------------

describe("requireTier middleware", () => {
  it("allows free user on free-tier route", async () => {
    const app = buildApp("free");
    const res = await app.request("/protected", {
      headers: { "x-user-id": "user-free" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.tier).toBe("free");
  });

  it("rejects free user on pro-tier route with 403", async () => {
    const app = buildApp("pro");
    const res = await app.request("/protected", {
      headers: { "x-user-id": "user-free" },
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("Upgrade required");
    expect(body.required).toBe("pro");
    expect(body.current).toBe("free");
    expect(body.upgradeUrl).toBe("/settings/billing");
  });

  it("allows pro user on pro-tier route", async () => {
    const app = buildApp("pro");
    const res = await app.request("/protected", {
      headers: { "x-user-id": "user-pro" },
    });
    expect(res.status).toBe(200);
  });

  it("allows enterprise user on team-tier route (higher includes lower)", async () => {
    const app = buildApp("team");
    const res = await app.request("/protected", {
      headers: { "x-user-id": "user-enterprise" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tier).toBe("enterprise");
  });

  it("returns 401 when no user is authenticated", async () => {
    const app = buildApp("free");
    const res = await app.request("/protected");
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Authentication required");
  });

  it("sets tier on context for downstream handlers", async () => {
    const { requireTier } = createFeatureGate({ getUserTier });
    const app = new Hono<AnyEnv>();
    app.use("/*", async (c, next) => {
      c.set("user", { id: "user-pro" });
      return next();
    });
    app.get("/check", requireTier("free"), (c) => {
      const tier = c.get("tier") as PlanTier;
      return c.json({ features: tier.features });
    });

    const res = await app.request("/check");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.features).toContain("premium_plugins");
  });
});

// ---------------------------------------------------------------------------
// requireFeature middleware
// ---------------------------------------------------------------------------

describe("requireFeature middleware", () => {
  it("allows when feature is present in tier", async () => {
    const app = buildFeatureApp("custom-domains");
    const res = await app.request("/feature", {
      headers: { "x-user-id": "user-pro" },
    });
    expect(res.status).toBe(200);
  });

  it("rejects when feature is not in tier with 403", async () => {
    const app = buildFeatureApp("sso");
    const res = await app.request("/feature", {
      headers: { "x-user-id": "user-pro" },
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("Feature not available on your plan");
    expect(body.feature).toBe("sso");
    expect(body.current).toBe("pro");
    expect(body.upgradeUrl).toBe("/settings/billing");
  });

  it("allows enterprise user for sso feature", async () => {
    const app = buildFeatureApp("sso");
    const res = await app.request("/feature", {
      headers: { "x-user-id": "user-enterprise" },
    });
    expect(res.status).toBe(200);
  });

  it("rejects free user for premium_plugins", async () => {
    const app = buildFeatureApp("premium_plugins");
    const res = await app.request("/feature", {
      headers: { "x-user-id": "user-free" },
    });
    expect(res.status).toBe(403);
  });

  it("resolves tier from user when not already on context", async () => {
    const { requireFeature } = createFeatureGate({ getUserTier });
    const app = new Hono<AnyEnv>();
    app.use("/*", async (c, next) => {
      c.set("user", { id: "user-team" });
      return next();
    });
    // requireFeature without requireTier first
    app.get("/standalone", requireFeature("audit-logs"), (c) => {
      return c.json({ ok: true });
    });

    const res = await app.request("/standalone");
    expect(res.status).toBe(200);
  });

  it("returns 401 when no user and no tier on context", async () => {
    const { requireFeature } = createFeatureGate({ getUserTier });
    const app = new Hono<AnyEnv>();
    app.get("/standalone", requireFeature("sso"), (c) => {
      return c.json({ ok: true });
    });

    const res = await app.request("/standalone");
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// checkPluginAccess
// ---------------------------------------------------------------------------

describe("checkPluginAccess", () => {
  const { checkPluginAccess } = createFeatureGate({ getUserTier });

  it("allows free plugin for free user", () => {
    expect(checkPluginAccess("free", freeTier)).toBe(true);
  });

  it("allows undefined tier plugin (defaults to free)", () => {
    expect(checkPluginAccess(undefined, freeTier)).toBe(true);
  });

  it("rejects premium plugin for free user", () => {
    expect(checkPluginAccess("premium", freeTier)).toBe(false);
  });

  it("allows premium plugin for pro user", () => {
    expect(checkPluginAccess("premium", proTier)).toBe(true);
  });

  it("allows premium plugin for enterprise user", () => {
    expect(checkPluginAccess("premium", enterpriseTier)).toBe(true);
  });
});
