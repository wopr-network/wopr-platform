// src/admin/admin-repository-types.ts
//
// Plain TypeScript interfaces for admin domain objects.
// No Drizzle types. No better-sqlite3. These are the contract
// the admin layer works against.

// ---------------------------------------------------------------------------
// AdminNote
// ---------------------------------------------------------------------------

export interface AdminNote {
  id: string;
  tenantId: string;
  authorId: string;
  content: string;
  isPinned: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface AdminNoteInput {
  tenantId: string;
  authorId: string;
  content: string;
  isPinned?: boolean;
}

export interface AdminNoteFilters {
  tenantId: string;
  limit?: number;
  offset?: number;
}

// ---------------------------------------------------------------------------
// TenantStatus
// ---------------------------------------------------------------------------

export type TenantAccountStatus = "active" | "grace_period" | "suspended" | "banned";

export const GRACE_PERIOD_DAYS = 3;
export const BAN_DELETE_DAYS = 30;

export interface TenantStatusRecord {
  tenantId: string;
  status: string;
  statusReason: string | null;
  statusChangedAt: number | null;
  statusChangedBy: string | null;
  graceDeadline: string | null;
  dataDeleteAfter: string | null;
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// BulkOperations
// ---------------------------------------------------------------------------

export interface UndoableGrant {
  operationId: string;
  tenantIds: string; // JSON-encoded string[]
  amountCredits: number;
  adminUser: string;
  createdAt: number;
  undoDeadline: number;
  undone: boolean;
}

export interface AdminUserRow {
  tenantId: string;
  name: string | null;
  email: string;
  status: string;
  role: string;
  creditBalanceCredits: number;
  agentCount: number;
  lastSeen: number | null;
  createdAt: number;
}
