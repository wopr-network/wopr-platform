import crypto from "node:crypto";
import { and, eq, lte, sql } from "drizzle-orm";
import type { DrizzleDb } from "../db/index.js";
import { accountDeletionRequests } from "../db/schema/account-deletion-requests.js";

export const DELETION_GRACE_DAYS = 30;

export interface DeletionRequest {
  id: string;
  tenantId: string;
  requestedBy: string;
  status: string;
  deleteAfter: string;
  cancelReason: string | null;
  completedAt: string | null;
  deletionSummary: string | null;
  createdAt: string;
  updatedAt: string;
}

export class AccountDeletionStore {
  constructor(private readonly db: DrizzleDb) {}

  /** Create a new deletion request with a 30-day grace period. Returns the created request. */
  create(tenantId: string, requestedBy: string): DeletionRequest {
    const id = crypto.randomUUID();
    this.db
      .insert(accountDeletionRequests)
      .values({
        id,
        tenantId,
        requestedBy,
        status: "pending",
        deleteAfter: sql`(datetime('now', '+${sql.raw(String(DELETION_GRACE_DAYS))} days'))`,
      })
      .run();
    const created = this.getById(id);
    if (!created) throw new Error(`Failed to retrieve newly created deletion request: ${id}`);
    return created;
  }

  /** Get a deletion request by ID. */
  getById(id: string): DeletionRequest | null {
    const row = this.db.select().from(accountDeletionRequests).where(eq(accountDeletionRequests.id, id)).get();
    return (row as DeletionRequest) ?? null;
  }

  /** Get the active (pending) deletion request for a tenant. */
  getPendingForTenant(tenantId: string): DeletionRequest | null {
    const row = this.db
      .select()
      .from(accountDeletionRequests)
      .where(and(eq(accountDeletionRequests.tenantId, tenantId), eq(accountDeletionRequests.status, "pending")))
      .get();
    return (row as DeletionRequest) ?? null;
  }

  /** Cancel a pending deletion request. */
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

  /** Mark a deletion request as completed with a summary. */
  markCompleted(id: string, summary: Record<string, number>): void {
    this.db
      .update(accountDeletionRequests)
      .set({
        status: "completed",
        completedAt: sql`(datetime('now'))`,
        deletionSummary: JSON.stringify(summary),
        updatedAt: sql`(datetime('now'))`,
      })
      .where(eq(accountDeletionRequests.id, id))
      .run();
  }

  /** Find all pending requests whose grace period has expired. */
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
      .all() as DeletionRequest[];
  }
}
