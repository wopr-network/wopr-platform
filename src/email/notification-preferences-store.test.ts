import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb, type DrizzleDb } from "../db/index.js";
import { NotificationPreferencesStore } from "./notification-preferences-store.js";

function setupDb(): DrizzleDb {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE notification_preferences (
      tenant_id TEXT PRIMARY KEY,
      billing_low_balance INTEGER NOT NULL DEFAULT 1,
      billing_receipts INTEGER NOT NULL DEFAULT 1,
      billing_auto_topup INTEGER NOT NULL DEFAULT 1,
      agent_channel_disconnect INTEGER NOT NULL DEFAULT 1,
      agent_status_changes INTEGER NOT NULL DEFAULT 0,
      account_role_changes INTEGER NOT NULL DEFAULT 1,
      account_team_invites INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);
  return createDb(sqlite);
}

describe("NotificationPreferencesStore", () => {
  let db: DrizzleDb;
  let store: NotificationPreferencesStore;

  beforeEach(() => {
    db = setupDb();
    store = new NotificationPreferencesStore(db);
  });

  describe("get", () => {
    it("returns defaults when no row exists", () => {
      const prefs = store.get("tenant-1");
      expect(prefs).toEqual({
        billing_low_balance: true,
        billing_receipts: true,
        billing_auto_topup: true,
        agent_channel_disconnect: true,
        agent_status_changes: false,
        account_role_changes: true,
        account_team_invites: true,
      });
    });

    it("returns stored values when row exists", () => {
      store.update("tenant-1", { billing_low_balance: false, agent_status_changes: true });
      const prefs = store.get("tenant-1");
      expect(prefs.billing_low_balance).toBe(false);
      expect(prefs.agent_status_changes).toBe(true);
    });

    it("maps integer 1 to true and 0 to false", () => {
      store.update("tenant-1", { billing_low_balance: true });
      const prefs = store.get("tenant-1");
      expect(typeof prefs.billing_low_balance).toBe("boolean");
      expect(prefs.billing_low_balance).toBe(true);
    });
  });

  describe("update", () => {
    it("creates row on first call (upsert)", () => {
      store.update("tenant-1", { billing_low_balance: false });
      const prefs = store.get("tenant-1");
      expect(prefs.billing_low_balance).toBe(false);
    });

    it("merges partial updates without touching unspecified fields", () => {
      store.update("tenant-1", { billing_low_balance: false });
      store.update("tenant-1", { billing_receipts: false });

      const prefs = store.get("tenant-1");
      expect(prefs.billing_low_balance).toBe(false);
      expect(prefs.billing_receipts).toBe(false);
      expect(prefs.billing_auto_topup).toBe(true); // default unchanged
    });

    it("allows setting all preferences at once", () => {
      store.update("tenant-1", {
        billing_low_balance: false,
        billing_receipts: false,
        billing_auto_topup: false,
        agent_channel_disconnect: false,
        agent_status_changes: true,
        account_role_changes: false,
        account_team_invites: false,
      });

      const prefs = store.get("tenant-1");
      expect(prefs.billing_low_balance).toBe(false);
      expect(prefs.billing_receipts).toBe(false);
      expect(prefs.billing_auto_topup).toBe(false);
      expect(prefs.agent_channel_disconnect).toBe(false);
      expect(prefs.agent_status_changes).toBe(true);
      expect(prefs.account_role_changes).toBe(false);
      expect(prefs.account_team_invites).toBe(false);
    });

    it("second call updates existing row", () => {
      store.update("tenant-1", { billing_low_balance: false });
      store.update("tenant-1", { billing_low_balance: true });

      const prefs = store.get("tenant-1");
      expect(prefs.billing_low_balance).toBe(true);
    });
  });
});
