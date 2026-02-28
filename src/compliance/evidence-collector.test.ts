import { describe, expect, it } from "vitest";
import { EvidenceCollector } from "./evidence-collector.js";

describe("EvidenceCollector", () => {
  it("returns a report with all sections populated", async () => {
    const mockAuditRepo = {
      count: async () => 5,
      countByAction: async () => ({ "auth.login": 3, "key.create": 2 }),
      getTimeRange: async () => ({
        oldest: "2026-01-01T00:00:00Z",
        newest: "2026-02-28T00:00:00Z",
      }),
    };

    const mockBackupStore = {
      listAll: async () => [
        { containerId: "c1", nodeId: "n1", lastBackupAt: Date.now(), lastBackupSuccess: true, isStale: false },
        {
          containerId: "c2",
          nodeId: "n1",
          lastBackupAt: Date.now() - 100_000_000,
          lastBackupSuccess: true,
          isStale: true,
        },
      ],
      listStale: async () => [
        {
          containerId: "c2",
          nodeId: "n1",
          lastBackupAt: Date.now() - 100_000_000,
          lastBackupSuccess: true,
          isStale: true,
        },
      ],
    };

    const mockAdminAuditRepo = {
      query: async () => ({ entries: [], total: 12 }),
      countByAction: async () => ({ "backup.restore": 1, "user.suspend": 11 }),
    };

    const mockTwoFactorRepo = {
      countMandated: async () => 3,
      countTotal: async () => 10,
    };

    const collector = new EvidenceCollector({
      auditRepo: mockAuditRepo as any,
      backupStore: mockBackupStore as any,
      adminAuditRepo: mockAdminAuditRepo as any,
      twoFactorRepo: mockTwoFactorRepo as any,
    });

    const now = new Date();
    const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
    const report = await collector.collect({
      from: ninetyDaysAgo.toISOString(),
      to: now.toISOString(),
    });

    expect(report.generatedAt).toBeDefined();
    expect(report.sections.accessLogging.totalEntries).toBe(5);
    expect(report.sections.backupRecovery.totalContainers).toBe(2);
    expect(report.sections.backupRecovery.staleContainers).toBe(1);
    expect(report.sections.encryption.algorithm).toBe("aes-256-gcm");
    expect(report.sections.mfaEnforcement.pluginEnabled).toBe(true);
    expect(report.sections.mfaEnforcement.tenantsWithMfaMandate).toBe(3);
    expect(report.sections.accessReview.adminActions).toBe(12);
  });

  it("handles empty data gracefully", async () => {
    const emptyAuditRepo = {
      count: async () => 0,
      countByAction: async () => ({}),
      getTimeRange: async () => ({ oldest: null, newest: null }),
    };

    const emptyBackupStore = {
      listAll: async () => [],
      listStale: async () => [],
    };

    const emptyAdminRepo = {
      query: async () => ({ entries: [], total: 0 }),
      countByAction: async () => ({}),
    };

    const emptyTwoFactorRepo = {
      countMandated: async () => 0,
      countTotal: async () => 0,
    };

    const collector = new EvidenceCollector({
      auditRepo: emptyAuditRepo as any,
      backupStore: emptyBackupStore as any,
      adminAuditRepo: emptyAdminRepo as any,
      twoFactorRepo: emptyTwoFactorRepo as any,
    });

    const report = await collector.collect({
      from: new Date(0).toISOString(),
      to: new Date().toISOString(),
    });

    expect(report.sections.accessLogging.totalEntries).toBe(0);
    expect(report.sections.backupRecovery.totalContainers).toBe(0);
    expect(report.sections.mfaEnforcement.tenantsWithMfaMandate).toBe(0);
  });
});
