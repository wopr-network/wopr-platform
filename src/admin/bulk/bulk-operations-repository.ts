import type Database from "better-sqlite3";
import { and, desc, eq, gt, inArray, like, lt, or, type SQL } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "../../db/schema/index.js";
import { adminUsers, bulkUndoGrants } from "../../db/schema/index.js";
import type { AdminUserRow, UndoableGrant } from "../admin-repository-types.js";

export type { AdminUserRow, UndoableGrant };

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface IBulkOperationsRepository {
  lookupTenants(tenantIds: string[]): Array<{ tenantId: string; name: string | null; email: string; status: string }>;

  lookupTenantsForExport(tenantIds: string[]): AdminUserRow[];

  listMatchingTenantIds(filters: {
    search?: string;
    status?: string;
    role?: string;
    hasCredits?: boolean;
    lowBalance?: boolean;
  }): string[];

  insertUndoableGrant(grant: UndoableGrant): void;
  getUndoableGrant(operationId: string): UndoableGrant | null;
  markGrantUndone(operationId: string): void;

  transaction<T>(fn: () => T): T;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class DrizzleBulkOperationsRepository implements IBulkOperationsRepository {
  constructor(
    private readonly db: BetterSQLite3Database<typeof schema>,
    private readonly sqlite: Database.Database,
  ) {}

  lookupTenants(tenantIds: string[]): Array<{ tenantId: string; name: string | null; email: string; status: string }> {
    if (tenantIds.length === 0) return [];
    return this.db
      .select({
        tenantId: adminUsers.tenantId,
        name: adminUsers.name,
        email: adminUsers.email,
        status: adminUsers.status,
      })
      .from(adminUsers)
      .where(inArray(adminUsers.tenantId, tenantIds))
      .all();
  }

  lookupTenantsForExport(tenantIds: string[]): AdminUserRow[] {
    if (tenantIds.length === 0) return [];
    return this.db
      .select()
      .from(adminUsers)
      .where(inArray(adminUsers.tenantId, tenantIds))
      .orderBy(desc(adminUsers.createdAt))
      .all()
      .map((r) => ({
        tenantId: r.tenantId,
        name: r.name,
        email: r.email,
        status: r.status,
        role: r.role,
        creditBalanceCents: r.creditBalanceCents,
        agentCount: r.agentCount,
        lastSeen: r.lastSeen,
        createdAt: r.createdAt,
      }));
  }

  listMatchingTenantIds(filters: {
    search?: string;
    status?: string;
    role?: string;
    hasCredits?: boolean;
    lowBalance?: boolean;
  }): string[] {
    const conditions: SQL[] = [];

    if (filters.search) {
      const pattern = `%${filters.search.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_")}%`;
      conditions.push(
        or(like(adminUsers.name, pattern), like(adminUsers.email, pattern), like(adminUsers.tenantId, pattern)) as SQL,
      );
    }
    if (filters.status) {
      conditions.push(eq(adminUsers.status, filters.status));
    }
    if (filters.role) {
      conditions.push(eq(adminUsers.role, filters.role));
    }
    if (filters.hasCredits === true) {
      conditions.push(gt(adminUsers.creditBalanceCents, 0));
    } else if (filters.hasCredits === false) {
      conditions.push(eq(adminUsers.creditBalanceCents, 0));
    }
    if (filters.lowBalance === true) {
      conditions.push(lt(adminUsers.creditBalanceCents, 500));
    }

    const base = this.db.select({ tenantId: adminUsers.tenantId }).from(adminUsers);
    const rows = conditions.length > 0 ? base.where(and(...conditions)).all() : base.all();
    return rows.map((r) => r.tenantId);
  }

  insertUndoableGrant(grant: UndoableGrant): void {
    this.db
      .insert(bulkUndoGrants)
      .values({
        operationId: grant.operationId,
        tenantIds: grant.tenantIds,
        amountCents: grant.amountCents,
        adminUser: grant.adminUser,
        createdAt: grant.createdAt,
        undoDeadline: grant.undoDeadline,
        undone: grant.undone ? 1 : 0,
      })
      .run();
  }

  getUndoableGrant(operationId: string): UndoableGrant | null {
    const row = this.db.select().from(bulkUndoGrants).where(eq(bulkUndoGrants.operationId, operationId)).get();
    if (!row) return null;
    return {
      operationId: row.operationId,
      tenantIds: row.tenantIds,
      amountCents: row.amountCents,
      adminUser: row.adminUser,
      createdAt: row.createdAt,
      undoDeadline: row.undoDeadline,
      undone: row.undone === 1,
    };
  }

  markGrantUndone(operationId: string): void {
    this.db.update(bulkUndoGrants).set({ undone: 1 }).where(eq(bulkUndoGrants.operationId, operationId)).run();
  }

  // Uses raw better-sqlite3 transaction because the transaction body
  // calls creditStore methods that also use raw better-sqlite3 directly.
  // Drizzle's .transaction() wouldn't wrap those inner calls.
  transaction<T>(fn: () => T): T {
    return this.sqlite.transaction(fn)();
  }
}
