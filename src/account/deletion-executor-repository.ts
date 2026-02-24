import type Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { adminAuditLog } from "../db/schema/admin-audit.js";
import { adminNotes } from "../db/schema/admin-notes.js";
import { auditLog } from "../db/schema/audit.js";
import { botInstances } from "../db/schema/bot-instances.js";
import { creditBalances, creditTransactions } from "../db/schema/credits.js";
import { emailNotifications } from "../db/schema/email-notifications.js";
import type * as schema from "../db/schema/index.js";
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

/** Repository interface for the multi-table tenant data purge. */
export interface IDeletionExecutorRepository {
  deleteBotInstances(tenantId: string): number;
  deleteCreditTransactions(tenantId: string): number;
  deleteCreditBalances(tenantId: string): number;
  deleteCreditAdjustments(tenantId: string): number | null;
  deleteMeterEvents(tenantId: string): number;
  deleteUsageSummaries(tenantId: string): number;
  deleteBillingPeriodSummaries(tenantId: string): number;
  deleteStripeUsageReports(tenantId: string): number;
  deleteNotificationQueue(tenantId: string): number;
  deleteNotificationPreferences(tenantId: string): number;
  deleteEmailNotifications(tenantId: string): number;
  deleteAuditLog(tenantId: string): number;
  anonymizeAuditLog(tenantId: string): number;
  deleteAdminNotes(tenantId: string): number;
  listSnapshotS3Keys(tenantId: string): { id: string; s3Key: string | null }[];
  deleteSnapshots(tenantId: string): number;
  deleteBackupStatus(tenantId: string): number | null;
  deletePayramCharges(tenantId: string): number;
  deleteTenantStatus(tenantId: string): number;
  deleteUserRolesByUser(tenantId: string): number;
  deleteUserRolesByTenant(tenantId: string): number;
  deleteTenantCustomers(tenantId: string): number;
  deleteAuthUser(tenantId: string): AuthDeletionResult;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class DrizzleDeletionExecutorRepository implements IDeletionExecutorRepository {
  constructor(
    private readonly db: BetterSQLite3Database<typeof schema>,
    private readonly rawDb: Database.Database,
    private readonly authDb?: Database.Database,
  ) {}

  deleteBotInstances(tenantId: string): number {
    return this.db.delete(botInstances).where(eq(botInstances.tenantId, tenantId)).run().changes;
  }

  deleteCreditTransactions(tenantId: string): number {
    return this.db.delete(creditTransactions).where(eq(creditTransactions.tenantId, tenantId)).run().changes;
  }

  deleteCreditBalances(tenantId: string): number {
    return this.db.delete(creditBalances).where(eq(creditBalances.tenantId, tenantId)).run().changes;
  }

  deleteCreditAdjustments(tenantId: string): number | null {
    try {
      return this.rawDb.prepare("DELETE FROM credit_adjustments WHERE tenant = ?").run(tenantId).changes;
    } catch (err) {
      if (err instanceof Error && err.message.includes("no such table")) return null;
      throw err;
    }
  }

  deleteMeterEvents(tenantId: string): number {
    return this.db.delete(meterEvents).where(eq(meterEvents.tenant, tenantId)).run().changes;
  }

  deleteUsageSummaries(tenantId: string): number {
    return this.db.delete(usageSummaries).where(eq(usageSummaries.tenant, tenantId)).run().changes;
  }

  deleteBillingPeriodSummaries(tenantId: string): number {
    return this.db.delete(billingPeriodSummaries).where(eq(billingPeriodSummaries.tenant, tenantId)).run().changes;
  }

  deleteStripeUsageReports(tenantId: string): number {
    return this.db.delete(stripeUsageReports).where(eq(stripeUsageReports.tenant, tenantId)).run().changes;
  }

  deleteNotificationQueue(tenantId: string): number {
    return this.db.delete(notificationQueue).where(eq(notificationQueue.tenantId, tenantId)).run().changes;
  }

  deleteNotificationPreferences(tenantId: string): number {
    return this.db.delete(notificationPreferences).where(eq(notificationPreferences.tenantId, tenantId)).run().changes;
  }

  deleteEmailNotifications(tenantId: string): number {
    return this.db.delete(emailNotifications).where(eq(emailNotifications.tenantId, tenantId)).run().changes;
  }

  deleteAuditLog(tenantId: string): number {
    return this.db.delete(auditLog).where(eq(auditLog.userId, tenantId)).run().changes;
  }

  anonymizeAuditLog(tenantId: string): number {
    return this.db
      .update(adminAuditLog)
      .set({ targetTenant: "[deleted]", targetUser: "[deleted]" })
      .where(eq(adminAuditLog.targetTenant, tenantId))
      .run().changes;
  }

  deleteAdminNotes(tenantId: string): number {
    return this.db.delete(adminNotes).where(eq(adminNotes.tenantId, tenantId)).run().changes;
  }

  listSnapshotS3Keys(tenantId: string): { id: string; s3Key: string | null }[] {
    return this.db
      .select({ id: snapshots.id, s3Key: snapshots.s3Key })
      .from(snapshots)
      .where(eq(snapshots.tenant, tenantId))
      .all();
  }

  deleteSnapshots(tenantId: string): number {
    return this.db.delete(snapshots).where(eq(snapshots.tenant, tenantId)).run().changes;
  }

  deleteBackupStatus(tenantId: string): number | null {
    try {
      return this.rawDb.prepare("DELETE FROM backup_status WHERE container_id LIKE ?").run(`%${tenantId}%`).changes;
    } catch (err) {
      if (err instanceof Error && err.message.includes("no such table")) return null;
      throw err;
    }
  }

  deletePayramCharges(tenantId: string): number {
    return this.db.delete(payramCharges).where(eq(payramCharges.tenantId, tenantId)).run().changes;
  }

  deleteTenantStatus(tenantId: string): number {
    return this.db.delete(tenantStatus).where(eq(tenantStatus.tenantId, tenantId)).run().changes;
  }

  deleteUserRolesByUser(tenantId: string): number {
    return this.db.delete(userRoles).where(eq(userRoles.userId, tenantId)).run().changes;
  }

  deleteUserRolesByTenant(tenantId: string): number {
    return this.db.delete(userRoles).where(eq(userRoles.tenantId, tenantId)).run().changes;
  }

  deleteTenantCustomers(tenantId: string): number {
    return this.db.delete(tenantCustomers).where(eq(tenantCustomers.tenant, tenantId)).run().changes;
  }

  deleteAuthUser(tenantId: string): AuthDeletionResult {
    if (!this.authDb) return { sessionChanges: 0, accountChanges: 0, verificationChanges: 0, userChanges: 0 };

    const sessionChanges = this.authDb.prepare("DELETE FROM session WHERE user_id = ?").run(tenantId).changes;
    const accountChanges = this.authDb.prepare("DELETE FROM account WHERE user_id = ?").run(tenantId).changes;

    let verificationChanges = 0;
    try {
      verificationChanges = this.authDb
        .prepare("DELETE FROM email_verification_tokens WHERE user_id = ?")
        .run(tenantId).changes;
    } catch {
      // Table may not exist
    }

    const userChanges = this.authDb.prepare("DELETE FROM user WHERE id = ?").run(tenantId).changes;

    return { sessionChanges, accountChanges, verificationChanges, userChanges };
  }
}
