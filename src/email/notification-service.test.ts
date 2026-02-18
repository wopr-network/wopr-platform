import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NotificationQueueStore } from "./notification-queue-store.js";
import { NotificationService } from "./notification-service.js";

function makeQueueStore(): NotificationQueueStore {
  return {
    enqueue: vi.fn().mockReturnValue("notif-id-123"),
    fetchPending: vi.fn().mockReturnValue([]),
    markSent: vi.fn(),
    markFailed: vi.fn(),
    listForTenant: vi.fn().mockReturnValue({ entries: [], total: 0 }),
  } as unknown as NotificationQueueStore;
}

describe("NotificationService", () => {
  let queue: NotificationQueueStore;
  let service: NotificationService;
  const BASE_URL = "https://app.wopr.bot";

  beforeEach(() => {
    queue = makeQueueStore();
    service = new NotificationService(queue, BASE_URL);
  });

  describe("notifyLowBalance", () => {
    it("enqueues a low-balance notification with correct data", () => {
      service.notifyLowBalance("tenant-1", "user@example.com", "$2.50", 5);
      expect(queue.enqueue).toHaveBeenCalledWith("tenant-1", "low-balance", {
        email: "user@example.com",
        balanceDollars: "$2.50",
        estimatedDaysRemaining: 5,
        creditsUrl: `${BASE_URL}/billing/credits`,
      });
    });
  });

  describe("notifyCreditsDepeleted", () => {
    it("enqueues a credits-depleted notification", () => {
      service.notifyCreditsDepeleted("tenant-1", "user@example.com");
      expect(queue.enqueue).toHaveBeenCalledWith("tenant-1", "credits-depleted", {
        email: "user@example.com",
        creditsUrl: `${BASE_URL}/billing/credits`,
      });
    });
  });

  describe("notifyGracePeriodStart", () => {
    it("enqueues a grace-period-start notification", () => {
      service.notifyGracePeriodStart("tenant-1", "user@example.com", "$0.50", 7);
      expect(queue.enqueue).toHaveBeenCalledWith("tenant-1", "grace-period-start", {
        email: "user@example.com",
        balanceDollars: "$0.50",
        graceDays: 7,
        creditsUrl: `${BASE_URL}/billing/credits`,
      });
    });
  });

  describe("notifyGracePeriodWarning", () => {
    it("enqueues a grace-period-warning notification", () => {
      service.notifyGracePeriodWarning("tenant-1", "user@example.com");
      expect(queue.enqueue).toHaveBeenCalledWith("tenant-1", "grace-period-warning", {
        email: "user@example.com",
        creditsUrl: `${BASE_URL}/billing/credits`,
      });
    });
  });

  describe("notifyAutoSuspended", () => {
    it("enqueues an auto-suspended notification", () => {
      service.notifyAutoSuspended("tenant-1", "user@example.com", "Grace period expired");
      expect(queue.enqueue).toHaveBeenCalledWith("tenant-1", "auto-suspended", {
        email: "user@example.com",
        reason: "Grace period expired",
        creditsUrl: `${BASE_URL}/billing/credits`,
      });
    });
  });

  describe("notifyAdminSuspended", () => {
    it("enqueues an admin-suspended notification", () => {
      service.notifyAdminSuspended("tenant-1", "user@example.com", "ToS violation");
      expect(queue.enqueue).toHaveBeenCalledWith("tenant-1", "admin-suspended", {
        email: "user@example.com",
        reason: "ToS violation",
      });
    });
  });

  describe("notifyAdminReactivated", () => {
    it("enqueues an admin-reactivated notification", () => {
      service.notifyAdminReactivated("tenant-1", "user@example.com");
      expect(queue.enqueue).toHaveBeenCalledWith("tenant-1", "admin-reactivated", {
        email: "user@example.com",
      });
    });
  });

  describe("notifyCreditsGranted", () => {
    it("enqueues a credits-granted notification", () => {
      service.notifyCreditsGranted("tenant-1", "user@example.com", "$5.00", "Support credit");
      expect(queue.enqueue).toHaveBeenCalledWith("tenant-1", "credits-granted", {
        email: "user@example.com",
        amountDollars: "$5.00",
        reason: "Support credit",
      });
    });
  });

  describe("notifyRoleChanged", () => {
    it("enqueues a role-changed notification", () => {
      service.notifyRoleChanged("tenant-1", "user@example.com", "tenant_admin");
      expect(queue.enqueue).toHaveBeenCalledWith("tenant-1", "role-changed", {
        email: "user@example.com",
        newRole: "tenant_admin",
      });
    });
  });

  describe("notifyTeamInvite", () => {
    it("enqueues a team-invite notification", () => {
      service.notifyTeamInvite("tenant-1", "user@example.com", "Acme Corp", "https://app.wopr.bot/invite/abc");
      expect(queue.enqueue).toHaveBeenCalledWith("tenant-1", "team-invite", {
        email: "user@example.com",
        tenantName: "Acme Corp",
        inviteUrl: "https://app.wopr.bot/invite/abc",
      });
    });
  });

  describe("notifyChannelDisconnected", () => {
    it("enqueues a channel-disconnected notification", () => {
      service.notifyChannelDisconnected("tenant-1", "user@example.com", "Discord", "MyBot", "Token expired");
      expect(queue.enqueue).toHaveBeenCalledWith("tenant-1", "channel-disconnected", {
        email: "user@example.com",
        channelName: "Discord",
        agentName: "MyBot",
        reason: "Token expired",
      });
    });
  });

  describe("sendCustomEmail", () => {
    it("enqueues a custom template notification", () => {
      service.sendCustomEmail("tenant-1", "user@example.com", "Hello there", "This is the body.");
      expect(queue.enqueue).toHaveBeenCalledWith("tenant-1", "custom", {
        email: "user@example.com",
        subject: "Hello there",
        bodyText: "This is the body.",
      });
    });
  });
});
