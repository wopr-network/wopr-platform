import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EmailClient } from "./client.js";
import type { NotificationPreferencesStore } from "./notification-preferences-store.js";
import type { NotificationQueueStore, QueuedNotification } from "./notification-queue-store.js";
import { NotificationWorker } from "./notification-worker.js";

vi.mock("../config/logger.js", () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

function makeNotif(overrides: Partial<QueuedNotification> = {}): QueuedNotification {
  return {
    id: "notif-1",
    tenantId: "tenant-1",
    template: "low-balance",
    data: JSON.stringify({ email: "user@example.com", balanceDollars: "$1.00" }),
    status: "pending",
    attempts: 0,
    retryAfter: null,
    sentAt: null,
    createdAt: Date.now(),
    ...overrides,
  };
}

function makeQueue(pending: QueuedNotification[] = []): NotificationQueueStore {
  return {
    enqueue: vi.fn().mockReturnValue("notif-id"),
    fetchPending: vi.fn().mockReturnValue(pending),
    markSent: vi.fn(),
    markFailed: vi.fn(),
    listForTenant: vi.fn().mockReturnValue({ entries: [], total: 0 }),
  } as unknown as NotificationQueueStore;
}

function makePrefs(prefs: Record<string, boolean> = {}): NotificationPreferencesStore {
  const defaultPrefs = {
    billing_low_balance: true,
    billing_receipts: true,
    billing_auto_topup: true,
    agent_channel_disconnect: true,
    agent_status_changes: false,
    account_role_changes: true,
    account_team_invites: true,
  };
  return {
    get: vi.fn().mockReturnValue({ ...defaultPrefs, ...prefs }),
    update: vi.fn(),
  } as unknown as NotificationPreferencesStore;
}

function makeEmailClient(): EmailClient {
  return {
    send: vi.fn().mockResolvedValue({ id: "email-123", success: true }),
    onEmailSent: vi.fn(),
  } as unknown as EmailClient;
}

describe("NotificationWorker", () => {
  let emailClient: EmailClient;

  beforeEach(() => {
    emailClient = makeEmailClient();
  });

  describe("processBatch", () => {
    it("sends emails for pending notifications and marks them sent", async () => {
      const notif = makeNotif();
      const queue = makeQueue([notif]);
      const prefs = makePrefs();
      const worker = new NotificationWorker({ queue, emailClient, preferences: prefs });

      const count = await worker.processBatch();

      expect(emailClient.send).toHaveBeenCalledOnce();
      expect(queue.markSent).toHaveBeenCalledWith("notif-1");
      expect(count).toBe(1);
    });

    it("returns 0 when no pending notifications", async () => {
      const queue = makeQueue([]);
      const prefs = makePrefs();
      const worker = new NotificationWorker({ queue, emailClient, preferences: prefs });

      const count = await worker.processBatch();
      expect(count).toBe(0);
      expect(emailClient.send).not.toHaveBeenCalled();
    });

    it("marks notification as failed (not sent) when email is missing", async () => {
      const notif = makeNotif({ data: JSON.stringify({}) }); // no email
      const queue = makeQueue([notif]);
      const prefs = makePrefs();
      const worker = new NotificationWorker({ queue, emailClient, preferences: prefs });

      await worker.processBatch();

      expect(emailClient.send).not.toHaveBeenCalled();
      expect(queue.markFailed).toHaveBeenCalledWith("notif-1", 1);
    });

    it("marks as sent (skipped) when user preference disables that template", async () => {
      const notif = makeNotif({ template: "agent-created" }); // pref: agent_status_changes
      const queue = makeQueue([notif]);
      const prefs = makePrefs({ agent_status_changes: false }); // disabled
      const worker = new NotificationWorker({ queue, emailClient, preferences: prefs });

      await worker.processBatch();

      expect(emailClient.send).not.toHaveBeenCalled();
      expect(queue.markSent).toHaveBeenCalledWith("notif-1"); // cleared from queue
    });

    it("sends critical templates even when preferences would disable them", async () => {
      // grace-period-start is critical — should bypass preference check
      const notif = makeNotif({
        template: "grace-period-start",
        data: JSON.stringify({
          email: "user@example.com",
          balanceDollars: "$0.00",
          graceDays: 7,
          creditsUrl: "https://app.wopr.bot/billing/credits",
        }),
      });
      const queue = makeQueue([notif]);
      // Even if all prefs disabled, critical templates must send
      const prefs = makePrefs({
        billing_low_balance: false,
        billing_receipts: false,
        billing_auto_topup: false,
      });
      const worker = new NotificationWorker({ queue, emailClient, preferences: prefs });

      await worker.processBatch();

      expect(emailClient.send).toHaveBeenCalledOnce();
      expect(queue.markSent).toHaveBeenCalledWith(notif.id);
    });

    it("marks as failed and increments attempts when send throws", async () => {
      const notif = makeNotif({ attempts: 2 });
      const queue = makeQueue([notif]);
      const prefs = makePrefs();
      vi.spyOn(emailClient, "send").mockRejectedValueOnce(new Error("Network error"));
      const worker = new NotificationWorker({ queue, emailClient, preferences: prefs });

      await worker.processBatch();

      expect(queue.markFailed).toHaveBeenCalledWith("notif-1", 3); // attempts + 1
      expect(queue.markSent).not.toHaveBeenCalled();
    });

    it("processes multiple notifications in one batch", async () => {
      const notif1 = makeNotif({ id: "n1" });
      const notif2 = makeNotif({
        id: "n2",
        template: "welcome",
        data: JSON.stringify({ email: "b@b.com" }),
      });
      const queue = makeQueue([notif1, notif2]);
      const prefs = makePrefs();
      const worker = new NotificationWorker({ queue, emailClient, preferences: prefs });

      const count = await worker.processBatch();

      expect(count).toBe(2);
      expect(emailClient.send).toHaveBeenCalledTimes(2);
    });

    it("respects custom batchSize", async () => {
      const notifs = Array.from({ length: 5 }, (_, i) => makeNotif({ id: `n${i}` }));
      const queue = makeQueue(notifs.slice(0, 3)); // fetchPending called with batchSize
      const prefs = makePrefs();
      const worker = new NotificationWorker({ queue, emailClient, preferences: prefs, batchSize: 3 });

      await worker.processBatch();

      expect(queue.fetchPending).toHaveBeenCalledWith(3);
    });
  });
});
