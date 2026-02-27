import { eq } from "drizzle-orm";
import type { DrizzleDb } from "../db/index.js";
import { notificationPreferences } from "../db/schema/notification-preferences.js";
import type { NotificationPrefs } from "./notification-repository-types.js";

// Re-export domain type for backward compat
export type { NotificationPrefs } from "./notification-repository-types.js";

type NotificationPrefsRow = typeof notificationPreferences.$inferInsert;

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

/** Repository interface for notification preferences. */
export interface INotificationPreferencesStore {
  get(tenantId: string): Promise<NotificationPrefs>;
  update(tenantId: string, prefs: Partial<NotificationPrefs>): Promise<void>;
}

// ---------------------------------------------------------------------------
// Drizzle Implementation
// ---------------------------------------------------------------------------

const DEFAULTS: NotificationPrefs = {
  billing_low_balance: true,
  billing_receipts: true,
  billing_auto_topup: true,
  agent_channel_disconnect: true,
  agent_status_changes: false,
  account_role_changes: true,
  account_team_invites: true,
};

export class DrizzleNotificationPreferencesStore implements INotificationPreferencesStore {
  constructor(private readonly db: DrizzleDb) {}

  /** Get preferences for a tenant. Returns defaults if no row exists. */
  async get(tenantId: string): Promise<NotificationPrefs> {
    const rows = await this.db
      .select()
      .from(notificationPreferences)
      .where(eq(notificationPreferences.tenantId, tenantId));
    const row = rows[0];

    if (!row) return { ...DEFAULTS };

    return {
      billing_low_balance: row.billingLowBalance,
      billing_receipts: row.billingReceipts,
      billing_auto_topup: row.billingAutoTopup,
      agent_channel_disconnect: row.agentChannelDisconnect,
      agent_status_changes: row.agentStatusChanges,
      account_role_changes: row.accountRoleChanges,
      account_team_invites: row.accountTeamInvites,
    };
  }

  /** Update preferences for a tenant. Upserts — creates row if missing. */
  async update(tenantId: string, prefs: Partial<NotificationPrefs>): Promise<void> {
    const values: Partial<NotificationPrefsRow> = { tenantId, updatedAt: Math.floor(Date.now() / 1000) };

    if (prefs.billing_low_balance !== undefined) values.billingLowBalance = prefs.billing_low_balance;
    if (prefs.billing_receipts !== undefined) values.billingReceipts = prefs.billing_receipts;
    if (prefs.billing_auto_topup !== undefined) values.billingAutoTopup = prefs.billing_auto_topup;
    if (prefs.agent_channel_disconnect !== undefined) values.agentChannelDisconnect = prefs.agent_channel_disconnect;
    if (prefs.agent_status_changes !== undefined) values.agentStatusChanges = prefs.agent_status_changes;
    if (prefs.account_role_changes !== undefined) values.accountRoleChanges = prefs.account_role_changes;
    if (prefs.account_team_invites !== undefined) values.accountTeamInvites = prefs.account_team_invites;

    // Get existing row to merge with defaults
    const existing = await this.db
      .select()
      .from(notificationPreferences)
      .where(eq(notificationPreferences.tenantId, tenantId));

    if (existing.length > 0) {
      // Only update the set fields
      await this.db.update(notificationPreferences).set(values).where(eq(notificationPreferences.tenantId, tenantId));
    } else {
      // Insert with defaults for unspecified fields
      const insertValues: NotificationPrefsRow = {
        tenantId,
        billingLowBalance: DEFAULTS.billing_low_balance,
        billingReceipts: DEFAULTS.billing_receipts,
        billingAutoTopup: DEFAULTS.billing_auto_topup,
        agentChannelDisconnect: DEFAULTS.agent_channel_disconnect,
        agentStatusChanges: DEFAULTS.agent_status_changes,
        accountRoleChanges: DEFAULTS.account_role_changes,
        accountTeamInvites: DEFAULTS.account_team_invites,
        updatedAt: Math.floor(Date.now() / 1000),
        ...values,
      };
      await this.db.insert(notificationPreferences).values(insertValues);
    }
  }
}

/** @deprecated Use DrizzleNotificationPreferencesStore directly. */
export { DrizzleNotificationPreferencesStore as NotificationPreferencesStore };
