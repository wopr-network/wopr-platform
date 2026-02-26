import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DrizzleDb } from "../db/index.js";
import { createTestDb } from "../test/db.js";
import { NotificationPreferencesStore } from "./notification-preferences-store.js";

describe("NotificationPreferencesStore", () => {
  let db: DrizzleDb;
  let pool: PGlite;
  let store: NotificationPreferencesStore;

  beforeEach(async () => {
    ({ db, pool } = await createTestDb());
    store = new NotificationPreferencesStore(db);
  });

  afterEach(async () => {
    await pool.close();
  });

  describe("get", () => {
    it("returns defaults when no row exists", async () => {
      const prefs = await store.get("tenant-1");
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

    it("returns stored values when row exists", async () => {
      await store.update("tenant-1", { billing_low_balance: false, agent_status_changes: true });
      const prefs = await store.get("tenant-1");
      expect(prefs.billing_low_balance).toBe(false);
      expect(prefs.agent_status_changes).toBe(true);
    });

    it("maps integer 1 to true and 0 to false", async () => {
      await store.update("tenant-1", { billing_low_balance: true });
      const prefs = await store.get("tenant-1");
      expect(typeof prefs.billing_low_balance).toBe("boolean");
      expect(prefs.billing_low_balance).toBe(true);
    });
  });

  describe("update", () => {
    it("creates row on first call (upsert)", async () => {
      await store.update("tenant-1", { billing_low_balance: false });
      const prefs = await store.get("tenant-1");
      expect(prefs.billing_low_balance).toBe(false);
    });

    it("merges partial updates without touching unspecified fields", async () => {
      await store.update("tenant-1", { billing_low_balance: false });
      await store.update("tenant-1", { billing_receipts: false });

      const prefs = await store.get("tenant-1");
      expect(prefs.billing_low_balance).toBe(false);
      expect(prefs.billing_receipts).toBe(false);
      expect(prefs.billing_auto_topup).toBe(true); // default unchanged
    });

    it("allows setting all preferences at once", async () => {
      await store.update("tenant-1", {
        billing_low_balance: false,
        billing_receipts: false,
        billing_auto_topup: false,
        agent_channel_disconnect: false,
        agent_status_changes: true,
        account_role_changes: false,
        account_team_invites: false,
      });

      const prefs = await store.get("tenant-1");
      expect(prefs.billing_low_balance).toBe(false);
      expect(prefs.billing_receipts).toBe(false);
      expect(prefs.billing_auto_topup).toBe(false);
      expect(prefs.agent_channel_disconnect).toBe(false);
      expect(prefs.agent_status_changes).toBe(true);
      expect(prefs.account_role_changes).toBe(false);
      expect(prefs.account_team_invites).toBe(false);
    });

    it("second call updates existing row", async () => {
      await store.update("tenant-1", { billing_low_balance: false });
      await store.update("tenant-1", { billing_low_balance: true });

      const prefs = await store.get("tenant-1");
      expect(prefs.billing_low_balance).toBe(true);
    });
  });
});
