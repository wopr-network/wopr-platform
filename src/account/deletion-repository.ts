import { and, desc, eq, lte, sql } from "drizzle-orm";
import type { DrizzleDb } from "../db/index.js";
import { accountDeletionRequests } from "../db/schema/account-deletion-requests.js";
import type { DeletionRequest } from "./repository-types.js";

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface InsertDeletionRequest {
  id: string;
  tenantId: string;
  requestedBy: string;
  graceDays: number;
  reason?: string | null;
}

/** Repository interface for account deletion request storage. */
export interface IDeletionRepository {
  insert(data: InsertDeletionRequest): Promise<void>;
  getById(id: string): Promise<DeletionRequest | null>;
  getPendingForTenant(tenantId: string): Promise<DeletionRequest | null>;
  cancel(id: string, reason: string): Promise<void>;
  markCompleted(id: string, summaryJson: string): Promise<void>;
  findExpired(): Promise<DeletionRequest[]>;
  list(opts: {
    status?: string;
    limit: number;
    offset: number;
  }): Promise<{ requests: DeletionRequest[]; total: number }>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class DrizzleDeletionRepository implements IDeletionRepository {
  constructor(private readonly db: DrizzleDb) {}

  async insert(data: InsertDeletionRequest): Promise<void> {
    await this.db.insert(accountDeletionRequests).values({
      id: data.id,
      tenantId: data.tenantId,
      requestedBy: data.requestedBy,
      status: "pending",
      reason: data.reason ?? null,
      deleteAfter: sql`(now() + make_interval(days => ${data.graceDays}))::text`,
    });
  }

  async getById(id: string): Promise<DeletionRequest | null> {
    const rows = await this.db.select().from(accountDeletionRequests).where(eq(accountDeletionRequests.id, id));
    return rows[0] ? toRequest(rows[0]) : null;
  }

  async getPendingForTenant(tenantId: string): Promise<DeletionRequest | null> {
    const rows = await this.db
      .select()
      .from(accountDeletionRequests)
      .where(and(eq(accountDeletionRequests.tenantId, tenantId), eq(accountDeletionRequests.status, "pending")));
    return rows[0] ? toRequest(rows[0]) : null;
  }

  async cancel(id: string, reason: string): Promise<void> {
    await this.db
      .update(accountDeletionRequests)
      .set({
        status: "cancelled",
        cancelReason: reason,
        updatedAt: sql`now()::text`,
      })
      .where(and(eq(accountDeletionRequests.id, id), eq(accountDeletionRequests.status, "pending")));
  }

  async markCompleted(id: string, summaryJson: string): Promise<void> {
    await this.db
      .update(accountDeletionRequests)
      .set({
        status: "completed",
        completedAt: sql`now()::text`,
        deletionSummary: summaryJson,
        updatedAt: sql`now()::text`,
      })
      .where(eq(accountDeletionRequests.id, id));
  }

  async findExpired(): Promise<DeletionRequest[]> {
    const rows = await this.db
      .select()
      .from(accountDeletionRequests)
      .where(
        and(eq(accountDeletionRequests.status, "pending"), lte(accountDeletionRequests.deleteAfter, sql`now()::text`)),
      );
    return rows.map(toRequest);
  }

  async list(opts: {
    status?: string;
    limit: number;
    offset: number;
  }): Promise<{ requests: DeletionRequest[]; total: number }> {
    const conditions = opts.status ? [eq(accountDeletionRequests.status, opts.status)] : [];
    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const [rows, countResult] = await Promise.all([
      this.db
        .select()
        .from(accountDeletionRequests)
        .where(where)
        .orderBy(desc(accountDeletionRequests.createdAt))
        .limit(opts.limit)
        .offset(opts.offset),
      this.db.select({ count: sql<number>`count(*)::int` }).from(accountDeletionRequests).where(where),
    ]);

    return { requests: rows.map(toRequest), total: countResult[0]?.count ?? 0 };
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
    reason: row.reason,
    cancelReason: row.cancelReason,
    completedAt: row.completedAt,
    deletionSummary: row.deletionSummary,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
