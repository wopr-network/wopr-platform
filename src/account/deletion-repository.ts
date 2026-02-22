import { and, eq, lte, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { accountDeletionRequests } from "../db/schema/account-deletion-requests.js";
import type * as schema from "../db/schema/index.js";
import type { DeletionRequest } from "./repository-types.js";

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface InsertDeletionRequest {
  id: string;
  tenantId: string;
  requestedBy: string;
  graceDays: number;
}

/** Repository interface for account deletion request storage. */
export interface IDeletionRepository {
  insert(data: InsertDeletionRequest): void;
  getById(id: string): DeletionRequest | null;
  getPendingForTenant(tenantId: string): DeletionRequest | null;
  cancel(id: string, reason: string): void;
  markCompleted(id: string, summaryJson: string): void;
  findExpired(): DeletionRequest[];
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class DrizzleDeletionRepository implements IDeletionRepository {
  constructor(private readonly db: BetterSQLite3Database<typeof schema>) {}

  insert(data: InsertDeletionRequest): void {
    this.db
      .insert(accountDeletionRequests)
      .values({
        id: data.id,
        tenantId: data.tenantId,
        requestedBy: data.requestedBy,
        status: "pending",
        deleteAfter: sql`(datetime('now', '+${sql.raw(String(data.graceDays))} days'))`,
      })
      .run();
  }

  getById(id: string): DeletionRequest | null {
    const row = this.db.select().from(accountDeletionRequests).where(eq(accountDeletionRequests.id, id)).get();
    return row ? toRequest(row) : null;
  }

  getPendingForTenant(tenantId: string): DeletionRequest | null {
    const row = this.db
      .select()
      .from(accountDeletionRequests)
      .where(and(eq(accountDeletionRequests.tenantId, tenantId), eq(accountDeletionRequests.status, "pending")))
      .get();
    return row ? toRequest(row) : null;
  }

  cancel(id: string, reason: string): void {
    this.db
      .update(accountDeletionRequests)
      .set({
        status: "cancelled",
        cancelReason: reason,
        updatedAt: sql`(datetime('now'))`,
      })
      .where(and(eq(accountDeletionRequests.id, id), eq(accountDeletionRequests.status, "pending")))
      .run();
  }

  markCompleted(id: string, summaryJson: string): void {
    this.db
      .update(accountDeletionRequests)
      .set({
        status: "completed",
        completedAt: sql`(datetime('now'))`,
        deletionSummary: summaryJson,
        updatedAt: sql`(datetime('now'))`,
      })
      .where(eq(accountDeletionRequests.id, id))
      .run();
  }

  findExpired(): DeletionRequest[] {
    return this.db
      .select()
      .from(accountDeletionRequests)
      .where(
        and(
          eq(accountDeletionRequests.status, "pending"),
          lte(accountDeletionRequests.deleteAfter, sql`(datetime('now'))`),
        ),
      )
      .all()
      .map(toRequest);
  }
}

// ---------------------------------------------------------------------------
// Row -> Domain mapper
// ---------------------------------------------------------------------------

function toRequest(row: typeof accountDeletionRequests.$inferSelect): DeletionRequest {
  return {
    id: row.id,
    tenantId: row.tenantId,
    requestedBy: row.requestedBy,
    status: row.status,
    deleteAfter: row.deleteAfter,
    cancelReason: row.cancelReason,
    completedAt: row.completedAt,
    deletionSummary: row.deletionSummary,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
