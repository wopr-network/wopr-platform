import { eq } from "drizzle-orm";
import type { DrizzleDb } from "../db/index.js";
import { notificationPreferences } from "../db/schema/notification-preferences.js";

type NotificationPrefsRow = typeof notificationPreferences.$inferInsert;

export interface NotificationPrefs {
  billing_low_balance: boolean;
  billing_receipts: boolean;
  billing_auto_topup: boolean;
  agent_channel_disconnect: boolean;
  agent_status_changes: boolean;
  account_role_changes: boolean;
  account_team_invites: boolean;
}

const DEFAULTS: NotificationPrefs = {
  billing_low_balance: true,
  billing_receipts: true,
  billing_auto_topup: true,
  agent_channel_disconnect: true,
  agent_status_changes: false,
  account_role_changes: true,
  account_team_invites: true,
};

export class NotificationPreferencesStore {
  constructor(private readonly db: DrizzleDb) {}

  /** Get preferences for a tenant. Returns defaults if no row exists. */
  get(tenantId: string): NotificationPrefs {
    const row = this.db
      .select()
      .from(notificationPreferences)
      .where(eq(notificationPreferences.tenantId, tenantId))
      .get();

    if (!row) return { ...DEFAULTS };

    return {
      billing_low_balance: row.billingLowBalance === 1,
      billing_receipts: row.billingReceipts === 1,
      billing_auto_topup: row.billingAutoTopup === 1,
      agent_channel_disconnect: row.agentChannelDisconnect === 1,
      agent_status_changes: row.agentStatusChanges === 1,
      account_role_changes: row.accountRoleChanges === 1,
      account_team_invites: row.accountTeamInvites === 1,
    };
  }

  /** Update preferences for a tenant. Upserts — creates row if missing. */
  update(tenantId: string, prefs: Partial<NotificationPrefs>): void {
    const values: Partial<NotificationPrefsRow> = { tenantId, updatedAt: Math.floor(Date.now() / 1000) };

    if (prefs.billing_low_balance !== undefined) values.billingLowBalance = prefs.billing_low_balance ? 1 : 0;
    if (prefs.billing_receipts !== undefined) values.billingReceipts = prefs.billing_receipts ? 1 : 0;
    if (prefs.billing_auto_topup !== undefined) values.billingAutoTopup = prefs.billing_auto_topup ? 1 : 0;
    if (prefs.agent_channel_disconnect !== undefined)
      values.agentChannelDisconnect = prefs.agent_channel_disconnect ? 1 : 0;
    if (prefs.agent_status_changes !== undefined) values.agentStatusChanges = prefs.agent_status_changes ? 1 : 0;
    if (prefs.account_role_changes !== undefined) values.accountRoleChanges = prefs.account_role_changes ? 1 : 0;
    if (prefs.account_team_invites !== undefined) values.accountTeamInvites = prefs.account_team_invites ? 1 : 0;

    // Get existing row to merge with defaults
    const existing = this.db
      .select()
      .from(notificationPreferences)
      .where(eq(notificationPreferences.tenantId, tenantId))
      .get();

    if (existing) {
      // Only update the set fields
      this.db.update(notificationPreferences).set(values).where(eq(notificationPreferences.tenantId, tenantId)).run();
    } else {
      // Insert with defaults for unspecified fields
      const insertValues: NotificationPrefsRow = {
        tenantId,
        billingLowBalance: DEFAULTS.billing_low_balance ? 1 : 0,
        billingReceipts: DEFAULTS.billing_receipts ? 1 : 0,
        billingAutoTopup: DEFAULTS.billing_auto_topup ? 1 : 0,
        agentChannelDisconnect: DEFAULTS.agent_channel_disconnect ? 1 : 0,
        agentStatusChanges: DEFAULTS.agent_status_changes ? 1 : 0,
        accountRoleChanges: DEFAULTS.account_role_changes ? 1 : 0,
        accountTeamInvites: DEFAULTS.account_team_invites ? 1 : 0,
        updatedAt: Math.floor(Date.now() / 1000),
        ...values,
      };
      this.db.insert(notificationPreferences).values(insertValues).run();
    }
  }
}
