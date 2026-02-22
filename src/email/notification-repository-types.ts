// src/email/notification-repository-types.ts
//
// Plain TypeScript interfaces for email/notification domain objects.
// No Drizzle types. No better-sqlite3. These are the contracts
// the notification layer works against.

// ---------------------------------------------------------------------------
// Notification Queue (email layer — src/email/notification-queue-store.ts)
// ---------------------------------------------------------------------------

export type NotificationStatus = "pending" | "sent" | "failed";

/** Domain object for a queued notification in the email layer. */
export interface QueuedNotification {
  id: string;
  tenantId: string;
  template: string;
  data: string; // JSON-serialized payload
  status: NotificationStatus;
  attempts: number;
  retryAfter: number | null;
  sentAt: number | null;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Notification Preferences
// ---------------------------------------------------------------------------

/** Per-tenant notification preference flags. */
export interface NotificationPrefs {
  billing_low_balance: boolean;
  billing_receipts: boolean;
  billing_auto_topup: boolean;
  agent_channel_disconnect: boolean;
  agent_status_changes: boolean;
  account_role_changes: boolean;
  account_team_invites: boolean;
}

// ---------------------------------------------------------------------------
// Admin Notification Queue (src/admin/notifications/store.ts)
// ---------------------------------------------------------------------------

export type NotificationEmailType =
  | "low_balance"
  | "grace_entered"
  | "suspended"
  | "receipt"
  | "welcome"
  | "reactivated";

export interface NotificationInput {
  tenantId: string;
  emailType: NotificationEmailType;
  recipientEmail: string;
  payload?: Record<string, unknown>;
  maxAttempts?: number;
}

export interface NotificationRow {
  id: string;
  tenantId: string;
  emailType: string;
  recipientEmail: string;
  payload: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  /** Unix epoch ms of last attempt */
  lastAttemptAt: number | null;
  lastError: string | null;
  /** Unix epoch ms for next retry. Null = immediately eligible. */
  retryAfter: number | null;
  /** Unix epoch ms */
  createdAt: number;
  /** Unix epoch ms */
  sentAt: number | null;
}
