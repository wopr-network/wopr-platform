import { eq, like, sql } from "drizzle-orm";
import type { DrizzleDb } from "../db/index.js";
import { adminAuditLog } from "../db/schema/admin-audit.js";
import { adminNotes } from "../db/schema/admin-notes.js";
import { auditLog } from "../db/schema/audit.js";
import { backupStatus } from "../db/schema/backup-status.js";
import { botInstances } from "../db/schema/bot-instances.js";
import { creditBalances, creditTransactions } from "../db/schema/credits.js";
import { emailNotifications } from "../db/schema/email-notifications.js";
import { billingPeriodSummaries, meterEvents, usageSummaries } from "../db/schema/meter-events.js";
import { notificationPreferences } from "../db/schema/notification-preferences.js";
import { notificationQueue } from "../db/schema/notification-queue.js";
import { payramCharges } from "../db/schema/payram.js";
import { snapshots } from "../db/schema/snapshots.js";
import { stripeUsageReports, tenantCustomers } from "../db/schema/tenant-customers.js";
import { tenantStatus } from "../db/schema/tenant-status.js";
import { userRoles } from "../db/schema/user-roles.js";

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface AuthDeletionResult {
  sessionChanges: number;
  accountChanges: number;
  verificationChanges: number;
  userChanges: number;
}

/** Minimal raw-query interface satisfied by both pg.Pool and PGlite. */
export interface RawQueryDb {
  query<T extends Record<string, unknown>>(
    query: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount?: number | null; affectedRows?: number }>;
}

/** Repository interface for the multi-table tenant data purge. */
export interface IDeletionExecutorRepository {
  deleteBotInstances(tenantId: string): Promise<number>;
  deleteCreditTransactions(tenantId: string): Promise<number>;
  deleteCreditBalances(tenantId: string): Promise<number>;
  deleteCreditAdjustments(tenantId: string): Promise<number | null>;
  deleteMeterEvents(tenantId: string): Promise<number>;
  deleteUsageSummaries(tenantId: string): Promise<number>;
  deleteBillingPeriodSummaries(tenantId: string): Promise<number>;
  deleteStripeUsageReports(tenantId: string): Promise<number>;
  deleteNotificationQueue(tenantId: string): Promise<number>;
  deleteNotificationPreferences(tenantId: string): Promise<number>;
  deleteEmailNotifications(tenantId: string): Promise<number>;
  deleteAuditLog(tenantId: string): Promise<number>;
  anonymizeAuditLog(tenantId: string): Promise<number>;
  deleteAdminNotes(tenantId: string): Promise<number>;
  listSnapshotS3Keys(tenantId: string): Promise<{ id: string; s3Key: string | null }[]>;
  deleteSnapshots(tenantId: string): Promise<number>;
  deleteBackupStatus(tenantId: string): Promise<number | null>;
  deletePayramCharges(tenantId: string): Promise<number>;
  deleteTenantStatus(tenantId: string): Promise<number>;
  deleteUserRolesByUser(tenantId: string): Promise<number>;
  deleteUserRolesByTenant(tenantId: string): Promise<number>;
  deleteTenantCustomers(tenantId: string): Promise<number>;
  deleteAuthUser(tenantId: string): Promise<AuthDeletionResult>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class DrizzleDeletionExecutorRepository implements IDeletionExecutorRepository {
  constructor(
    private readonly db: DrizzleDb,
    private readonly authDb?: RawQueryDb,
  ) {}

  async deleteBotInstances(tenantId: string): Promise<number> {
    const rows = await this.db
      .delete(botInstances)
      .where(eq(botInstances.tenantId, tenantId))
      .returning({ id: botInstances.id });
    return rows.length;
  }

  async deleteCreditTransactions(tenantId: string): Promise<number> {
    const rows = await this.db
      .delete(creditTransactions)
      .where(eq(creditTransactions.tenantId, tenantId))
      .returning({ id: creditTransactions.id });
    return rows.length;
  }

  async deleteCreditBalances(tenantId: string): Promise<number> {
    const rows = await this.db
      .delete(creditBalances)
      .where(eq(creditBalances.tenantId, tenantId))
      .returning({ tenantId: creditBalances.tenantId });
    return rows.length;
  }

  async deleteCreditAdjustments(tenantId: string): Promise<number | null> {
    try {
      const result = await this.db.execute(sql`DELETE FROM credit_adjustments WHERE tenant = ${tenantId}`);
      return (result as unknown as { rowCount: number | null }).rowCount ?? 0;
    } catch {
      // Table may not exist (legacy table not in Drizzle schema)
      return null;
    }
  }

  async deleteMeterEvents(tenantId: string): Promise<number> {
    const rows = await this.db
      .delete(meterEvents)
      .where(eq(meterEvents.tenant, tenantId))
      .returning({ id: meterEvents.id });
    return rows.length;
  }

  async deleteUsageSummaries(tenantId: string): Promise<number> {
    const rows = await this.db
      .delete(usageSummaries)
      .where(eq(usageSummaries.tenant, tenantId))
      .returning({ id: usageSummaries.id });
    return rows.length;
  }

  async deleteBillingPeriodSummaries(tenantId: string): Promise<number> {
    const rows = await this.db
      .delete(billingPeriodSummaries)
      .where(eq(billingPeriodSummaries.tenant, tenantId))
      .returning({ id: billingPeriodSummaries.id });
    return rows.length;
  }

  async deleteStripeUsageReports(tenantId: string): Promise<number> {
    const rows = await this.db
      .delete(stripeUsageReports)
      .where(eq(stripeUsageReports.tenant, tenantId))
      .returning({ id: stripeUsageReports.id });
    return rows.length;
  }

  async deleteNotificationQueue(tenantId: string): Promise<number> {
    const rows = await this.db
      .delete(notificationQueue)
      .where(eq(notificationQueue.tenantId, tenantId))
      .returning({ id: notificationQueue.id });
    return rows.length;
  }

  async deleteNotificationPreferences(tenantId: string): Promise<number> {
    const rows = await this.db
      .delete(notificationPreferences)
      .where(eq(notificationPreferences.tenantId, tenantId))
      .returning({ tenantId: notificationPreferences.tenantId });
    return rows.length;
  }

  async deleteEmailNotifications(tenantId: string): Promise<number> {
    const rows = await this.db
      .delete(emailNotifications)
      .where(eq(emailNotifications.tenantId, tenantId))
      .returning({ id: emailNotifications.id });
    return rows.length;
  }

  async deleteAuditLog(tenantId: string): Promise<number> {
    const rows = await this.db.delete(auditLog).where(eq(auditLog.userId, tenantId)).returning({ id: auditLog.id });
    return rows.length;
  }

  async anonymizeAuditLog(tenantId: string): Promise<number> {
    const rows = await this.db
      .update(adminAuditLog)
      .set({ targetTenant: "[deleted]", targetUser: "[deleted]" })
      .where(eq(adminAuditLog.targetTenant, tenantId))
      .returning({ id: adminAuditLog.id });
    return rows.length;
  }

  async deleteAdminNotes(tenantId: string): Promise<number> {
    const rows = await this.db
      .delete(adminNotes)
      .where(eq(adminNotes.tenantId, tenantId))
      .returning({ id: adminNotes.id });
    return rows.length;
  }

  async listSnapshotS3Keys(tenantId: string): Promise<{ id: string; s3Key: string | null }[]> {
    return this.db
      .select({ id: snapshots.id, s3Key: snapshots.s3Key })
      .from(snapshots)
      .where(eq(snapshots.tenant, tenantId));
  }

  async deleteSnapshots(tenantId: string): Promise<number> {
    const rows = await this.db.delete(snapshots).where(eq(snapshots.tenant, tenantId)).returning({ id: snapshots.id });
    return rows.length;
  }

  async deleteBackupStatus(tenantId: string): Promise<number | null> {
    const rows = await this.db
      .delete(backupStatus)
      .where(like(backupStatus.containerId, `%${tenantId}%`))
      .returning({ containerId: backupStatus.containerId });
    return rows.length;
  }

  async deletePayramCharges(tenantId: string): Promise<number> {
    const rows = await this.db
      .delete(payramCharges)
      .where(eq(payramCharges.tenantId, tenantId))
      .returning({ referenceId: payramCharges.referenceId });
    return rows.length;
  }

  async deleteTenantStatus(tenantId: string): Promise<number> {
    const rows = await this.db
      .delete(tenantStatus)
      .where(eq(tenantStatus.tenantId, tenantId))
      .returning({ tenantId: tenantStatus.tenantId });
    return rows.length;
  }

  async deleteUserRolesByUser(tenantId: string): Promise<number> {
    const rows = await this.db
      .delete(userRoles)
      .where(eq(userRoles.userId, tenantId))
      .returning({ userId: userRoles.userId });
    return rows.length;
  }

  async deleteUserRolesByTenant(tenantId: string): Promise<number> {
    const rows = await this.db
      .delete(userRoles)
      .where(eq(userRoles.tenantId, tenantId))
      .returning({ userId: userRoles.userId });
    return rows.length;
  }

  async deleteTenantCustomers(tenantId: string): Promise<number> {
    const rows = await this.db
      .delete(tenantCustomers)
      .where(eq(tenantCustomers.tenant, tenantId))
      .returning({ tenant: tenantCustomers.tenant });
    return rows.length;
  }

  async deleteAuthUser(tenantId: string): Promise<AuthDeletionResult> {
    if (!this.authDb) {
      return { sessionChanges: 0, accountChanges: 0, verificationChanges: 0, userChanges: 0 };
    }

    const sessionResult = await this.authDb.query("DELETE FROM session WHERE user_id = $1", [tenantId]);
    const accountResult = await this.authDb.query("DELETE FROM account WHERE user_id = $1", [tenantId]);

    let verificationChanges = 0;
    try {
      const verResult = await this.authDb.query("DELETE FROM email_verification_tokens WHERE user_id = $1", [tenantId]);
      verificationChanges = verResult.affectedRows ?? verResult.rowCount ?? 0;
    } catch {
      // Table may not exist
    }

    const userResult = await this.authDb.query('DELETE FROM "user" WHERE id = $1', [tenantId]);

    return {
      sessionChanges: sessionResult.affectedRows ?? sessionResult.rowCount ?? 0,
      accountChanges: accountResult.affectedRows ?? accountResult.rowCount ?? 0,
      verificationChanges,
      userChanges: userResult.affectedRows ?? userResult.rowCount ?? 0,
    };
  }
}
