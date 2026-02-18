import crypto from "node:crypto";
import type Database from "better-sqlite3";
import type { AdminAuditLog } from "../audit-log.js";
import type { CreditAdjustmentStore } from "../credits/adjustment-store.js";
import type { TenantStatusStore } from "../tenant-status/tenant-status-store.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MAX_BULK_SIZE = 500;
export const UNDO_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BulkActionType = "grant" | "suspend" | "reactivate" | "export";

export interface BulkResult {
  operationId: string;
  action: BulkActionType;
  requested: number;
  succeeded: number;
  failed: number;
  errors: Array<{ tenantId: string; error: string }>;
}

export interface BulkGrantResult extends BulkResult {
  action: "grant";
  totalAmountCents: number;
  undoDeadline: number;
}

export interface BulkExportResult {
  operationId: string;
  csv: string;
  rowCount: number;
}

export interface BulkGrantInput {
  tenantIds: string[];
  amountCents: number;
  reason: string;
  notifyByEmail: boolean;
}

export interface BulkSuspendInput {
  tenantIds: string[];
  reason: string;
  notifyByEmail: boolean;
}

export interface BulkReactivateInput {
  tenantIds: string[];
}

export interface ExportField {
  key: "account_info" | "credit_balance" | "monthly_products" | "lifetime_spend" | "last_seen" | "transaction_history";
  enabled: boolean;
}

export interface BulkExportInput {
  tenantIds: string[];
  fields: ExportField[];
}

// Internal type for the DB row
interface UndoableGrantRow {
  operation_id: string;
  tenant_ids: string;
  amount_cents: number;
  admin_user: string;
  created_at: number;
  undo_deadline: number;
  undone: number;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class BulkOperationsStore {
  constructor(
    private readonly db: Database.Database,
    private readonly creditStore: CreditAdjustmentStore,
    private readonly tenantStatusStore: TenantStatusStore,
    private readonly auditLog: AdminAuditLog,
  ) {}

  // --- Validation ---

  private validateTenantIds(tenantIds: string[]): void {
    if (tenantIds.length === 0) {
      throw new Error("At least one tenant must be selected");
    }
    if (tenantIds.length > MAX_BULK_SIZE) {
      throw new Error(`Maximum ${MAX_BULK_SIZE} tenants per bulk operation`);
    }
  }

  // --- Dry Run ---

  dryRun(tenantIds: string[]): Array<{ tenantId: string; name: string | null; email: string; status: string }> {
    this.validateTenantIds(tenantIds);
    const placeholders = tenantIds.map(() => "?").join(",");
    const rows = this.db
      .prepare(`SELECT tenant_id, name, email, status FROM admin_users WHERE tenant_id IN (${placeholders})`)
      .all(...tenantIds) as Array<{ tenant_id: string; name: string | null; email: string; status: string }>;
    return rows.map((r) => ({ tenantId: r.tenant_id, name: r.name, email: r.email, status: r.status }));
  }

  // --- Mass Grant ---

  bulkGrant(input: BulkGrantInput, adminUser: string): BulkGrantResult {
    this.validateTenantIds(input.tenantIds);
    const operationId = crypto.randomUUID();
    const errors: Array<{ tenantId: string; error: string }> = [];
    let succeeded = 0;

    const succeededIds: string[] = [];

    // Wrapped in a transaction for batch performance — individual errors are
    // caught so partial success is expected (this is NOT all-or-nothing).
    this.db.transaction(() => {
      for (const tenantId of input.tenantIds) {
        try {
          this.creditStore.grant(tenantId, input.amountCents, input.reason, adminUser);
          succeeded++;
          succeededIds.push(tenantId);
        } catch (err) {
          errors.push({ tenantId, error: err instanceof Error ? err.message : String(err) });
        }
      }
    })();

    const now = Date.now();
    const undoDeadline = now + UNDO_WINDOW_MS;

    this.db
      .prepare(
        `INSERT INTO bulk_undo_grants (operation_id, tenant_ids, amount_cents, admin_user, created_at, undo_deadline, undone)
         VALUES (?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(operationId, JSON.stringify(succeededIds), input.amountCents, adminUser, now, undoDeadline);

    this.auditLog.log({
      adminUser,
      action: "bulk.grant",
      category: "bulk",
      details: {
        operationId,
        tenantIds: input.tenantIds,
        amountCents: input.amountCents,
        reason: input.reason,
        notifyByEmail: input.notifyByEmail,
        succeeded,
        failed: errors.length,
        errors: errors.length > 0 ? errors : undefined,
      },
    });

    return {
      operationId,
      action: "grant",
      requested: input.tenantIds.length,
      succeeded,
      failed: errors.length,
      errors,
      totalAmountCents: input.amountCents * succeeded,
      undoDeadline,
    };
  }

  // --- Undo Grant ---

  undoGrant(operationId: string, adminUser: string): BulkResult {
    const row = this.db.prepare("SELECT * FROM bulk_undo_grants WHERE operation_id = ?").get(operationId) as
      | UndoableGrantRow
      | undefined;

    if (!row) throw new Error("Grant operation not found");
    if (row.undone) throw new Error("Grant operation has already been undone");
    if (Date.now() > row.undo_deadline) throw new Error("Undo window has expired (5 minutes)");

    const tenantIds: string[] = JSON.parse(row.tenant_ids);
    const errors: Array<{ tenantId: string; error: string }> = [];
    let succeeded = 0;

    this.db.transaction(() => {
      for (const tenantId of tenantIds) {
        try {
          this.creditStore.correction(tenantId, -row.amount_cents, `Undo bulk grant ${operationId}`, adminUser);
          succeeded++;
        } catch (err) {
          errors.push({ tenantId, error: err instanceof Error ? err.message : String(err) });
        }
      }
      if (errors.length === 0) {
        this.db.prepare("UPDATE bulk_undo_grants SET undone = 1 WHERE operation_id = ?").run(operationId);
      }
    })();

    this.auditLog.log({
      adminUser,
      action: "bulk.grant.undo",
      category: "bulk",
      details: {
        operationId,
        tenantIds,
        amountCents: row.amount_cents,
        succeeded,
        failed: errors.length,
      },
    });

    return {
      operationId,
      action: "grant",
      requested: tenantIds.length,
      succeeded,
      failed: errors.length,
      errors,
    };
  }

  // --- Mass Suspend ---

  bulkSuspend(input: BulkSuspendInput, adminUser: string): BulkResult {
    this.validateTenantIds(input.tenantIds);
    const operationId = crypto.randomUUID();
    const errors: Array<{ tenantId: string; error: string }> = [];
    let succeeded = 0;

    for (const tenantId of input.tenantIds) {
      try {
        const current = this.tenantStatusStore.getStatus(tenantId);
        if (current === "banned") {
          errors.push({ tenantId, error: "Cannot suspend a banned account" });
          continue;
        }
        if (current === "suspended") {
          errors.push({ tenantId, error: "Already suspended" });
          continue;
        }
        this.tenantStatusStore.suspend(tenantId, input.reason, adminUser);
        succeeded++;
      } catch (err) {
        errors.push({ tenantId, error: err instanceof Error ? err.message : String(err) });
      }
    }

    this.auditLog.log({
      adminUser,
      action: "bulk.suspend",
      category: "bulk",
      details: {
        operationId,
        tenantIds: input.tenantIds,
        reason: input.reason,
        notifyByEmail: input.notifyByEmail,
        succeeded,
        failed: errors.length,
        errors: errors.length > 0 ? errors : undefined,
      },
    });

    return {
      operationId,
      action: "suspend",
      requested: input.tenantIds.length,
      succeeded,
      failed: errors.length,
      errors,
    };
  }

  // --- Mass Reactivate ---

  bulkReactivate(input: BulkReactivateInput, adminUser: string): BulkResult {
    this.validateTenantIds(input.tenantIds);
    const operationId = crypto.randomUUID();
    const errors: Array<{ tenantId: string; error: string }> = [];
    let succeeded = 0;

    for (const tenantId of input.tenantIds) {
      try {
        const current = this.tenantStatusStore.getStatus(tenantId);
        if (current === "banned") {
          errors.push({ tenantId, error: "Cannot reactivate a banned account" });
          continue;
        }
        if (current === "active") {
          errors.push({ tenantId, error: "Already active" });
          continue;
        }
        this.tenantStatusStore.reactivate(tenantId, adminUser);
        succeeded++;
      } catch (err) {
        errors.push({ tenantId, error: err instanceof Error ? err.message : String(err) });
      }
    }

    this.auditLog.log({
      adminUser,
      action: "bulk.reactivate",
      category: "bulk",
      details: {
        operationId,
        tenantIds: input.tenantIds,
        succeeded,
        failed: errors.length,
        errors: errors.length > 0 ? errors : undefined,
      },
    });

    return {
      operationId,
      action: "reactivate",
      requested: input.tenantIds.length,
      succeeded,
      failed: errors.length,
      errors,
    };
  }

  // --- Export CSV ---

  bulkExport(input: BulkExportInput, adminUser: string): BulkExportResult {
    this.validateTenantIds(input.tenantIds);
    const operationId = crypto.randomUUID();

    const enabledKeys = new Set(input.fields.filter((f) => f.enabled).map((f) => f.key));
    const placeholders = input.tenantIds.map(() => "?").join(",");
    const rows = this.db
      .prepare(`SELECT * FROM admin_users WHERE tenant_id IN (${placeholders}) ORDER BY created_at DESC`)
      .all(...input.tenantIds) as Array<Record<string, unknown>>;

    const headers: string[] = ["tenant_id"];
    if (enabledKeys.has("account_info")) headers.push("name", "email", "status", "role");
    if (enabledKeys.has("credit_balance")) headers.push("credit_balance_cents");
    if (enabledKeys.has("monthly_products")) headers.push("agent_count");
    if (enabledKeys.has("lifetime_spend")) headers.push("balance_cents");
    if (enabledKeys.has("last_seen")) headers.push("last_seen");

    const csvEscape = (v: string): string => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const lines = rows.map((r) => {
      const fields: string[] = [csvEscape(String(r.tenant_id ?? ""))];
      if (enabledKeys.has("account_info")) {
        fields.push(
          csvEscape(String(r.name ?? "")),
          csvEscape(String(r.email ?? "")),
          csvEscape(String(r.status ?? "")),
          csvEscape(String(r.role ?? "")),
        );
      }
      if (enabledKeys.has("credit_balance")) fields.push(String(r.credit_balance_cents ?? 0));
      if (enabledKeys.has("monthly_products")) fields.push(String(r.agent_count ?? 0));
      if (enabledKeys.has("lifetime_spend")) {
        const spend = this.creditStore.getBalance(String(r.tenant_id));
        fields.push(String(spend));
      }
      if (enabledKeys.has("last_seen")) fields.push(String(r.last_seen ?? ""));
      return fields.join(",");
    });

    const csv = [headers.join(","), ...lines].join("\n");

    this.auditLog.log({
      adminUser,
      action: "bulk.export",
      category: "bulk",
      details: {
        operationId,
        tenantIds: input.tenantIds,
        fields: Array.from(enabledKeys),
        rowCount: rows.length,
      },
    });

    return { operationId, csv, rowCount: rows.length };
  }

  // --- Select All Matching Filters ---

  listMatchingTenantIds(filters: {
    search?: string;
    status?: string;
    role?: string;
    hasCredits?: boolean;
    lowBalance?: boolean;
  }): string[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters.search) {
      const pattern = `%${filters.search.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_")}%`;
      conditions.push("(name LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\' OR tenant_id LIKE ? ESCAPE '\\')");
      params.push(pattern, pattern, pattern);
    }
    if (filters.status) {
      conditions.push("status = ?");
      params.push(filters.status);
    }
    if (filters.role) {
      conditions.push("role = ?");
      params.push(filters.role);
    }
    if (filters.hasCredits === true) conditions.push("credit_balance_cents > 0");
    else if (filters.hasCredits === false) conditions.push("credit_balance_cents = 0");
    if (filters.lowBalance === true) conditions.push("credit_balance_cents < 500");

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.db.prepare(`SELECT tenant_id FROM admin_users ${where}`).all(...params) as Array<{
      tenant_id: string;
    }>;
    return rows.map((r) => r.tenant_id);
  }
}
