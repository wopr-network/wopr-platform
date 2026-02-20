import { eq } from "drizzle-orm";
import type { DrizzleDb } from "../db/index.js";
import { adminAuditLog } from "../db/schema/admin-audit.js";
import { adminNotes } from "../db/schema/admin-notes.js";
import { auditLog } from "../db/schema/audit.js";
import { botInstances } from "../db/schema/bot-instances.js";
import { creditBalances, creditTransactions } from "../db/schema/credits.js";
import { emailNotifications } from "../db/schema/email-notifications.js";
import { billingPeriodSummaries, meterEvents, usageSummaries } from "../db/schema/meter-events.js";
import { notificationPreferences } from "../db/schema/notification-preferences.js";
import { notificationQueue } from "../db/schema/notification-queue.js";
import { payramCharges } from "../db/schema/payram.js";
import { snapshots } from "../db/schema/snapshots.js";
import { stripeUsageReports, tenantCustomers } from "../db/schema/stripe.js";
import { tenantStatus } from "../db/schema/tenant-status.js";
import { userRoles } from "../db/schema/user-roles.js";

export interface DeletionExecutorDeps {
  db: DrizzleDb;
  /** Raw better-sqlite3 database for tables not in Drizzle schema (credit_adjustments). */
  rawDb: import("better-sqlite3").Database;
  stripe?: { customers: { del: (id: string) => Promise<unknown> } };
  tenantStore?: { getByTenant: (tenant: string) => { stripe_customer_id: string } | null };
  /** Auth database handle — used to delete user from better-auth tables. */
  authDb?: import("better-sqlite3").Database;
}

export interface DeletionResult {
  tenantId: string;
  deletedCounts: Record<string, number>;
  stripeCustomerDeleted: boolean;
  authUserDeleted: boolean;
  errors: string[];
}

/**
 * Execute a full data purge for a tenant.
 *
 * Order of operations:
 * 1. Cancel Stripe subscription / delete Stripe customer
 * 2. Delete bot instances (should already be suspended)
 * 3. Delete financial records (credit_transactions, credit_balances, credit_adjustments)
 * 4. Delete usage/metering data
 * 5. Delete notification data
 * 6. Delete audit log entries (user-facing ones; admin audit retained per retention policy)
 * 7. Delete tenant status, user roles, snapshots, backups
 * 8. Delete Stripe customer mapping
 * 9. Delete Better Auth user record
 *
 * NOTE on Stripe: Per the issue spec, Stripe records may need retention for tax.
 * We delete the Stripe customer mapping in our DB but only ATTEMPT to delete the
 * Stripe customer via API. If Stripe deletion fails (e.g., has invoices), we log
 * the error but continue. Stripe retains its own records for compliance.
 *
 * NOTE on S3 snapshots: The executor deletes snapshot DB rows but does NOT delete
 * the actual S3 objects. A follow-up task should add S3 object deletion via the
 * SnapshotManager.
 */
export async function executeDeletion(deps: DeletionExecutorDeps, tenantId: string): Promise<DeletionResult> {
  const { db, rawDb, stripe, tenantStore, authDb } = deps;
  const result: DeletionResult = {
    tenantId,
    deletedCounts: {},
    stripeCustomerDeleted: false,
    authUserDeleted: false,
    errors: [],
  };

  // Helper to count deletions
  function deleteFromTable(tableName: string, fn: () => { changes: number }): void {
    try {
      const r = fn();
      result.deletedCounts[tableName] = r.changes;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`${tableName}: ${msg}`);
    }
  }

  // 1. Cancel Stripe customer
  if (stripe && tenantStore) {
    try {
      const mapping = tenantStore.getByTenant(tenantId);
      if (mapping) {
        await stripe.customers.del(mapping.stripe_customer_id);
        result.stripeCustomerDeleted = true;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`stripe_customer: ${msg}`);
      // Continue — Stripe data is their responsibility for tax retention
    }
  }

  // 2. Bot instances
  deleteFromTable("bot_instances", () => db.delete(botInstances).where(eq(botInstances.tenantId, tenantId)).run());

  // 3. Credit transactions & balances
  deleteFromTable("credit_transactions", () =>
    db.delete(creditTransactions).where(eq(creditTransactions.tenantId, tenantId)).run(),
  );
  deleteFromTable("credit_balances", () =>
    db.delete(creditBalances).where(eq(creditBalances.tenantId, tenantId)).run(),
  );

  // 3b. credit_adjustments (raw SQL table, not in Drizzle schema)
  try {
    const stmt = rawDb.prepare("DELETE FROM credit_adjustments WHERE tenant = ?");
    const r = stmt.run(tenantId);
    result.deletedCounts.credit_adjustments = r.changes;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Table may not exist if never initialized
    if (!msg.includes("no such table")) {
      result.errors.push(`credit_adjustments: ${msg}`);
    }
  }

  // 4. Usage & metering
  deleteFromTable("meter_events", () => db.delete(meterEvents).where(eq(meterEvents.tenant, tenantId)).run());
  deleteFromTable("usage_summaries", () => db.delete(usageSummaries).where(eq(usageSummaries.tenant, tenantId)).run());
  deleteFromTable("billing_period_summaries", () =>
    db.delete(billingPeriodSummaries).where(eq(billingPeriodSummaries.tenant, tenantId)).run(),
  );
  deleteFromTable("stripe_usage_reports", () =>
    db.delete(stripeUsageReports).where(eq(stripeUsageReports.tenant, tenantId)).run(),
  );

  // 5. Notification data
  deleteFromTable("notification_queue", () =>
    db.delete(notificationQueue).where(eq(notificationQueue.tenantId, tenantId)).run(),
  );
  deleteFromTable("notification_preferences", () =>
    db.delete(notificationPreferences).where(eq(notificationPreferences.tenantId, tenantId)).run(),
  );
  deleteFromTable("email_notifications", () =>
    db.delete(emailNotifications).where(eq(emailNotifications.tenantId, tenantId)).run(),
  );

  // 6. Audit logs (user-facing)
  deleteFromTable("audit_log", () => db.delete(auditLog).where(eq(auditLog.userId, tenantId)).run());
  // Admin audit: anonymize rather than delete (regulatory requirement)
  try {
    const r = db
      .update(adminAuditLog)
      .set({ targetTenant: "[deleted]", targetUser: "[deleted]" })
      .where(eq(adminAuditLog.targetTenant, tenantId))
      .run();
    result.deletedCounts.admin_audit_log_anonymized = r.changes;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.errors.push(`admin_audit_log: ${msg}`);
  }

  // 7. Admin notes for this tenant
  deleteFromTable("admin_notes", () => db.delete(adminNotes).where(eq(adminNotes.tenantId, tenantId)).run());

  // 8. Snapshots (DB rows only; S3 objects require separate cleanup)
  // NOTE: S3 object deletion for snapshots is tracked in WOP-853.
  deleteFromTable("snapshots", () => db.delete(snapshots).where(eq(snapshots.tenant, tenantId)).run());
  // backup_status uses containerId (container name pattern "tenant_{id}")
  // Escape LIKE special characters in tenantId to prevent cross-tenant wildcard matching.
  try {
    const escapedTenantId = tenantId.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
    const r = rawDb
      .prepare("DELETE FROM backup_status WHERE container_id LIKE ? ESCAPE '\\'")
      .run(`%${escapedTenantId}%`);
    result.deletedCounts.backup_status = r.changes;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("no such table")) {
      result.errors.push(`backup_status: ${msg}`);
    }
  }

  // 9. PayRam charges
  deleteFromTable("payram_charges", () => db.delete(payramCharges).where(eq(payramCharges.tenantId, tenantId)).run());

  // 10. Tenant status
  deleteFromTable("tenant_status", () => db.delete(tenantStatus).where(eq(tenantStatus.tenantId, tenantId)).run());

  // 11. User roles (both as user and as tenant)
  deleteFromTable("user_roles", () => db.delete(userRoles).where(eq(userRoles.userId, tenantId)).run());
  try {
    const r2 = db.delete(userRoles).where(eq(userRoles.tenantId, tenantId)).run();
    result.deletedCounts.user_roles_tenant = r2.changes;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.errors.push(`user_roles_tenant: ${msg}`);
  }

  // 12. Stripe customer mapping
  deleteFromTable("tenant_customers", () =>
    db.delete(tenantCustomers).where(eq(tenantCustomers.tenant, tenantId)).run(),
  );

  // 13. Better Auth user record — each operation has its own error boundary so a
  //     failure on sessions or accounts cannot prevent the critical user-row deletion.
  if (authDb) {
    try {
      const sessionResult = authDb.prepare("DELETE FROM session WHERE user_id = ?").run(tenantId);
      result.deletedCounts.auth_sessions = sessionResult.changes;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`auth_sessions: ${msg}`);
    }

    try {
      const accountResult = authDb.prepare("DELETE FROM account WHERE user_id = ?").run(tenantId);
      result.deletedCounts.auth_accounts = accountResult.changes;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`auth_accounts: ${msg}`);
    }

    try {
      const verificationResult = authDb
        .prepare("DELETE FROM email_verification_tokens WHERE user_id = ?")
        .run(tenantId);
      result.deletedCounts.auth_verification_tokens = verificationResult.changes;
    } catch {
      // Table may not exist in all better-auth versions — not an error
    }

    try {
      const userResult = authDb.prepare("DELETE FROM user WHERE id = ?").run(tenantId);
      result.deletedCounts.auth_users = userResult.changes;
      result.authUserDeleted = userResult.changes > 0;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`auth_user: ${msg}`);
    }
  }

  return result;
}
