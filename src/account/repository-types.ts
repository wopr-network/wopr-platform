// src/account/repository-types.ts
//
// Plain TypeScript interfaces for account domain objects.
// No Drizzle types. No better-sqlite3.

/** Plain domain object for a deletion request — mirrors `account_deletion_requests` table. */
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
