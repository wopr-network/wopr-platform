import { describe, expect, it, vi } from "vitest";

// Mock auth to REJECT — separate file so module isolation is clean
vi.mock("../../auth/index.js", () => ({
  buildTokenMetadataMap: vi.fn().mockReturnValue(new Map()),
  // biome-ignore lint/suspicious/noExplicitAny: vi.fn() mock context
  scopedBearerAuthWithTenant: vi.fn().mockReturnValue(async (c: any) => {
    return c.json({ error: "Unauthorized" }, 401);
  }),
}));

import { incidentResponseRoutes } from "./incident-response.js";

describe("incidentResponseRoutes — non-admin rejection", () => {
  it("POST /severity returns 401 for non-admin", async () => {
    const res = await incidentResponseRoutes.request("/severity", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        stripeReachable: true,
        webhooksReceiving: true,
        gatewayErrorRate: 0,
        creditDeductionFailures: 0,
        dlqDepth: 0,
        tenantsWithNegativeBalance: 0,
        autoTopupFailures: 0,
        firingAlertCount: 0,
      }),
    });
    expect(res.status).toBe(401);
  });

  it("GET /escalation/SEV1 returns 401 for non-admin", async () => {
    const res = await incidentResponseRoutes.request("/escalation/SEV1");
    expect(res.status).toBe(401);
  });

  it("GET /procedure/SEV1 returns 401 for non-admin", async () => {
    const res = await incidentResponseRoutes.request("/procedure/SEV1");
    expect(res.status).toBe(401);
  });

  it("POST /communicate returns 401 for non-admin", async () => {
    const res = await incidentResponseRoutes.request("/communicate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
  });

  it("POST /postmortem returns 401 for non-admin", async () => {
    const res = await incidentResponseRoutes.request("/postmortem", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
  });
});
