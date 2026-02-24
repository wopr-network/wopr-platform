import type { IDeletionExecutorRepository } from "./deletion-executor-repository.js";

export interface DeletionExecutorDeps {
  repo: IDeletionExecutorRepository;
  stripe?: { customers: { del: (id: string) => Promise<unknown> } };
  tenantStore?: { getByTenant: (tenant: string) => { processor_customer_id: string } | null };
  /** S3-compatible client for deleting snapshot objects during GDPR purge. */
  spaces?: { remove: (remotePath: string) => Promise<void> };
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
 * NOTE on S3 snapshots: The executor deletes S3 objects for all tenant snapshots
 * before deleting the DB rows. S3 deletion failures are logged but do not abort
 * the purge.
 */
export async function executeDeletion(deps: DeletionExecutorDeps, tenantId: string): Promise<DeletionResult> {
  const { repo, stripe, tenantStore, spaces } = deps;
  const result: DeletionResult = {
    tenantId,
    deletedCounts: {},
    stripeCustomerDeleted: false,
    authUserDeleted: false,
    errors: [],
  };

  function safeDelete(tableName: string, fn: () => number): void {
    try {
      result.deletedCounts[tableName] = fn();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`${tableName}: ${msg}`);
    }
  }

  function safeDeleteNullable(tableName: string, fn: () => number | null): void {
    try {
      const count = fn();
      if (count !== null) result.deletedCounts[tableName] = count;
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
        await stripe.customers.del(mapping.processor_customer_id);
        result.stripeCustomerDeleted = true;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`stripe_customer: ${msg}`);
      // Continue — Stripe data is their responsibility for tax retention
    }
  }

  // 2. Bot instances
  safeDelete("bot_instances", () => repo.deleteBotInstances(tenantId));

  // 3. Credit transactions & balances
  safeDelete("credit_transactions", () => repo.deleteCreditTransactions(tenantId));
  safeDelete("credit_balances", () => repo.deleteCreditBalances(tenantId));

  // 3b. credit_adjustments (raw SQL table, not in Drizzle schema)
  safeDeleteNullable("credit_adjustments", () => repo.deleteCreditAdjustments(tenantId));

  // 4. Usage & metering
  safeDelete("meter_events", () => repo.deleteMeterEvents(tenantId));
  safeDelete("usage_summaries", () => repo.deleteUsageSummaries(tenantId));
  safeDelete("billing_period_summaries", () => repo.deleteBillingPeriodSummaries(tenantId));
  safeDelete("stripe_usage_reports", () => repo.deleteStripeUsageReports(tenantId));

  // 5. Notification data
  safeDelete("notification_queue", () => repo.deleteNotificationQueue(tenantId));
  safeDelete("notification_preferences", () => repo.deleteNotificationPreferences(tenantId));
  safeDelete("email_notifications", () => repo.deleteEmailNotifications(tenantId));

  // 6. Audit logs (user-facing)
  safeDelete("audit_log", () => repo.deleteAuditLog(tenantId));
  // Admin audit: anonymize rather than delete (regulatory requirement)
  try {
    result.deletedCounts.admin_audit_log_anonymized = repo.anonymizeAuditLog(tenantId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.errors.push(`admin_audit_log: ${msg}`);
  }

  // 7. Admin notes for this tenant
  safeDelete("admin_notes", () => repo.deleteAdminNotes(tenantId));

  // 8. Snapshots — delete S3 objects BEFORE deleting DB rows
  if (spaces) {
    const snapshotRows = repo.listSnapshotS3Keys(tenantId);

    for (const row of snapshotRows) {
      if (row.s3Key) {
        try {
          await spaces.remove(row.s3Key);
          result.deletedCounts[`s3_object:${row.id}`] = 1;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          result.errors.push(`s3_snapshot(${row.id}): ${msg}`);
          // Continue — log error but don't abort deletion
        }
      }
    }
  }

  // Delete snapshot DB rows
  safeDelete("snapshots", () => repo.deleteSnapshots(tenantId));
  // backup_status uses containerId (container name pattern "tenant_{id}")
  safeDeleteNullable("backup_status", () => repo.deleteBackupStatus(tenantId));

  // 9. PayRam charges
  safeDelete("payram_charges", () => repo.deletePayramCharges(tenantId));

  // 10. Tenant status
  safeDelete("tenant_status", () => repo.deleteTenantStatus(tenantId));

  // 11. User roles (both as user and as tenant)
  safeDelete("user_roles", () => repo.deleteUserRolesByUser(tenantId));
  try {
    result.deletedCounts.user_roles_tenant = repo.deleteUserRolesByTenant(tenantId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.errors.push(`user_roles_tenant: ${msg}`);
  }

  // 12. Stripe customer mapping
  safeDelete("tenant_customers", () => repo.deleteTenantCustomers(tenantId));

  // 13. Better Auth user record
  try {
    const authResult = repo.deleteAuthUser(tenantId);
    result.deletedCounts.auth_sessions = authResult.sessionChanges;
    result.deletedCounts.auth_accounts = authResult.accountChanges;
    result.deletedCounts.auth_verification_tokens = authResult.verificationChanges;
    result.deletedCounts.auth_users = authResult.userChanges;
    result.authUserDeleted = authResult.userChanges > 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.errors.push(`auth_user: ${msg}`);
  }

  return result;
}
