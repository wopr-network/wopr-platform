import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createAdminComplianceRoutes } from "./admin-compliance.js";

describe("GET /evidence", () => {
  it("returns 200 with evidence report", async () => {
    const mockCollector = {
      collect: async () => ({
        generatedAt: new Date().toISOString(),
        period: { from: "2026-01-01T00:00:00Z", to: "2026-02-28T00:00:00Z" },
        sections: {
          accessLogging: {
            totalEntries: 5,
            oldestEntry: null,
            newestEntry: null,
            actionBreakdown: {},
            retentionDays: 365,
          },
          backupRecovery: {
            totalContainers: 2,
            containersWithRecentBackup: 1,
            staleContainers: 1,
            lastVerificationReport: null,
          },
          encryption: { algorithm: "aes-256-gcm", keyDerivation: "hmac-sha256", tlsEnforced: true },
          mfaEnforcement: { pluginEnabled: true, tenantsWithMfaMandate: 3, totalTenants: 10 },
          accessReview: { adminActions: 12, adminActionBreakdown: {} },
        },
      }),
    };

    const app = new Hono();
    app.route("/", createAdminComplianceRoutes(mockCollector as any));

    const res = await app.request("/evidence");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sections.encryption.algorithm).toBe("aes-256-gcm");
  });
});
