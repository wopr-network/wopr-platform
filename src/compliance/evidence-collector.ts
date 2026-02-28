import { getRetentionDays } from "../audit/retention.js";

export interface EvidenceReport {
  generatedAt: string;
  period: { from: string; to: string };
  sections: {
    accessLogging: AccessLoggingEvidence;
    backupRecovery: BackupRecoveryEvidence;
    encryption: EncryptionEvidence;
    mfaEnforcement: MfaEvidence;
    accessReview: AccessReviewEvidence;
  };
}

export interface AccessLoggingEvidence {
  totalEntries: number;
  oldestEntry: string | null;
  newestEntry: string | null;
  actionBreakdown: Record<string, number>;
  retentionDays: number;
}

export interface BackupRecoveryEvidence {
  totalContainers: number;
  containersWithRecentBackup: number;
  staleContainers: number;
  lastVerificationReport: null;
}

export interface EncryptionEvidence {
  algorithm: string;
  keyDerivation: string;
  tlsEnforced: boolean;
}

export interface MfaEvidence {
  pluginEnabled: boolean;
  tenantsWithMfaMandate: number;
  totalTenants: number;
}

export interface AccessReviewEvidence {
  adminActions: number;
  adminActionBreakdown: Record<string, number>;
}

/** Deps injected into EvidenceCollector — subset interfaces to avoid importing full repo types. */
export interface EvidenceCollectorDeps {
  auditRepo: {
    count(filters: { since?: number; until?: number }): Promise<number>;
    countByAction(filters: { since?: number; until?: number }): Promise<Record<string, number>>;
    getTimeRange(filters: {
      since?: number;
      until?: number;
    }): Promise<{ oldest: string | null; newest: string | null }>;
  };
  backupStore: {
    listAll(): Promise<Array<{ containerId: string; isStale: boolean }>>;
    listStale(): Promise<Array<{ containerId: string }>>;
  };
  adminAuditRepo: {
    query(filters: { from?: number; to?: number }): Promise<{ entries: unknown[]; total: number }>;
    countByAction(filters: { from?: number; to?: number }): Promise<Record<string, number>>;
  };
  twoFactorRepo: {
    countMandated(): Promise<number>;
    countTotal(): Promise<number>;
  };
}

export class EvidenceCollector {
  private deps: EvidenceCollectorDeps;

  constructor(deps: EvidenceCollectorDeps) {
    this.deps = deps;
  }

  async collect(period: { from: string; to: string }): Promise<EvidenceReport> {
    const since = new Date(period.from).getTime();
    const until = new Date(period.to).getTime();

    const [
      totalEntries,
      actionBreakdown,
      timeRange,
      allBackups,
      staleBackups,
      adminResult,
      adminActionBreakdown,
      mandatedCount,
      totalTenants,
    ] = await Promise.all([
      this.deps.auditRepo.count({ since, until }),
      this.deps.auditRepo.countByAction({ since, until }),
      this.deps.auditRepo.getTimeRange({ since, until }),
      this.deps.backupStore.listAll(),
      this.deps.backupStore.listStale(),
      this.deps.adminAuditRepo.query({ from: since, to: until }),
      this.deps.adminAuditRepo.countByAction({ from: since, to: until }),
      this.deps.twoFactorRepo.countMandated(),
      this.deps.twoFactorRepo.countTotal(),
    ]);

    return {
      generatedAt: new Date().toISOString(),
      period: { from: period.from, to: period.to },
      sections: {
        accessLogging: {
          totalEntries,
          oldestEntry: timeRange.oldest,
          newestEntry: timeRange.newest,
          actionBreakdown,
          retentionDays: getRetentionDays(),
        },
        backupRecovery: {
          totalContainers: allBackups.length,
          containersWithRecentBackup: allBackups.length - staleBackups.length,
          staleContainers: staleBackups.length,
          lastVerificationReport: null,
        },
        encryption: {
          algorithm: "aes-256-gcm",
          keyDerivation: "hmac-sha256",
          tlsEnforced: true,
        },
        mfaEnforcement: {
          pluginEnabled: true,
          tenantsWithMfaMandate: mandatedCount,
          totalTenants,
        },
        accessReview: {
          adminActions: adminResult.total,
          adminActionBreakdown,
        },
      },
    };
  }
}
