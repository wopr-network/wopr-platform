import { describe, expect, it } from "vitest";
import { renderNotificationTemplate } from "./notification-templates.js";

describe("renderNotificationTemplate", () => {
  describe("credits-depleted", () => {
    it("renders valid HTML and text with subject", () => {
      const result = renderNotificationTemplate("credits-depleted", {
        email: "user@example.com",
        creditsUrl: "https://app.wopr.bot/billing/credits",
      });
      expect(result.subject).toBeTruthy();
      expect(result.html).toContain("<!DOCTYPE html>");
      expect(result.text).toBeTruthy();
    });
  });

  describe("grace-period-start", () => {
    it("renders with balance and grace days", () => {
      const result = renderNotificationTemplate("grace-period-start", {
        email: "user@example.com",
        balanceDollars: "$0.50",
        graceDays: 7,
        creditsUrl: "https://app.wopr.bot/billing/credits",
      });
      expect(result.html).toContain("$0.50");
      expect(result.html).toContain("7");
    });
  });

  describe("grace-period-warning", () => {
    it("renders a warning subject", () => {
      const result = renderNotificationTemplate("grace-period-warning", {
        email: "user@example.com",
        creditsUrl: "https://app.wopr.bot/billing/credits",
      });
      expect(result.subject).toMatch(/last chance|suspended|tomorrow/i);
    });
  });

  describe("auto-suspended", () => {
    it("renders with reason", () => {
      const result = renderNotificationTemplate("auto-suspended", {
        email: "user@example.com",
        reason: "Grace period expired",
        creditsUrl: "https://app.wopr.bot/billing/credits",
      });
      expect(result.html).toContain("Grace period expired");
    });
  });

  describe("auto-topup-success", () => {
    it("renders with amount and new balance", () => {
      const result = renderNotificationTemplate("auto-topup-success", {
        email: "user@example.com",
        amountDollars: "$50.00",
        newBalanceDollars: "$55.00",
        creditsUrl: "https://app.wopr.bot/billing/credits",
      });
      expect(result.html).toContain("$50.00");
      expect(result.html).toContain("$55.00");
    });
  });

  describe("auto-topup-failed", () => {
    it("renders a failed top-up notification", () => {
      const result = renderNotificationTemplate("auto-topup-failed", {
        email: "user@example.com",
        creditsUrl: "https://app.wopr.bot/billing/credits",
      });
      expect(result.subject).toMatch(/auto top-up failed|failed/i);
    });
  });

  describe("crypto-payment-confirmed", () => {
    it("renders with amount", () => {
      const result = renderNotificationTemplate("crypto-payment-confirmed", {
        email: "user@example.com",
        amountDollars: "$25.00",
        newBalanceDollars: "$30.00",
      });
      expect(result.html).toContain("$25.00");
    });
  });

  describe("admin-suspended", () => {
    it("renders with reason", () => {
      const result = renderNotificationTemplate("admin-suspended", {
        email: "user@example.com",
        reason: "ToS violation",
      });
      expect(result.html).toContain("ToS violation");
    });
  });

  describe("admin-reactivated", () => {
    it("renders a reactivation email", () => {
      const result = renderNotificationTemplate("admin-reactivated", {
        email: "user@example.com",
      });
      expect(result.subject).toMatch(/reactivated/i);
    });
  });

  describe("credits-granted", () => {
    it("renders with amount and reason", () => {
      const result = renderNotificationTemplate("credits-granted", {
        email: "user@example.com",
        amountDollars: "$5.00",
        reason: "Support credit",
      });
      expect(result.html).toContain("$5.00");
      expect(result.html).toContain("Support credit");
    });
  });

  describe("role-changed", () => {
    it("renders with new role", () => {
      const result = renderNotificationTemplate("role-changed", {
        email: "user@example.com",
        newRole: "tenant_admin",
      });
      expect(result.html).toContain("tenant_admin");
    });
  });

  describe("team-invite", () => {
    it("renders with tenant name and invite URL", () => {
      const result = renderNotificationTemplate("team-invite", {
        email: "user@example.com",
        tenantName: "Acme Corp",
        inviteUrl: "https://app.wopr.bot/invite/abc",
      });
      expect(result.html).toContain("Acme Corp");
    });
  });

  describe("agent-created", () => {
    it("renders with agent name", () => {
      const result = renderNotificationTemplate("agent-created", {
        email: "user@example.com",
        agentName: "HAL 9000",
      });
      expect(result.html).toContain("HAL 9000");
    });
  });

  describe("channel-connected", () => {
    it("renders with channel and agent name", () => {
      const result = renderNotificationTemplate("channel-connected", {
        email: "user@example.com",
        channelName: "Discord",
        agentName: "MyBot",
      });
      expect(result.html).toContain("Discord");
      expect(result.html).toContain("MyBot");
    });
  });

  describe("channel-disconnected", () => {
    it("renders with channel, agent, and reason", () => {
      const result = renderNotificationTemplate("channel-disconnected", {
        email: "user@example.com",
        channelName: "Discord",
        agentName: "MyBot",
        reason: "Token expired",
      });
      expect(result.html).toContain("Discord");
      expect(result.html).toContain("Token expired");
    });
  });

  describe("agent-suspended", () => {
    it("renders with agent name and reason", () => {
      const result = renderNotificationTemplate("agent-suspended", {
        email: "user@example.com",
        agentName: "MyBot",
        reason: "Account suspended",
      });
      expect(result.html).toContain("MyBot");
    });
  });

  describe("custom", () => {
    it("renders with custom subject and body", () => {
      const result = renderNotificationTemplate("custom", {
        email: "user@example.com",
        subject: "Hello from WOPR",
        bodyText: "This is a custom message.",
      });
      expect(result.subject).toBe("Hello from WOPR");
      expect(result.html).toContain("This is a custom message.");
      expect(result.text).toContain("This is a custom message.");
    });

    it("escapes HTML in bodyText to prevent XSS", () => {
      const result = renderNotificationTemplate("custom", {
        email: "user@example.com",
        subject: "Test",
        bodyText: "<script>alert('xss')</script>",
      });
      expect(result.html).not.toContain("<script>");
      expect(result.html).toContain("&lt;script&gt;");
    });

    it("converts newlines to <br> tags in HTML", () => {
      const result = renderNotificationTemplate("custom", {
        email: "user@example.com",
        subject: "Test",
        bodyText: "Line one\nLine two",
      });
      expect(result.html).toContain("<br");
    });
  });

  describe("dividend-weekly-digest", () => {
    it("renders dividend-weekly-digest template", () => {
      const result = renderNotificationTemplate("dividend-weekly-digest", {
        email: "alice@example.com",
        weeklyTotalDollars: "$3.50",
        weeklyTotalCents: 350,
        lifetimeTotalDollars: "$42.00",
        distributionCount: 5,
        poolAvgCents: 2000,
        activeUsersAvg: 10,
        nextDividendDate: "Tuesday, February 25, 2026",
        weekStartDate: "February 17",
        weekEndDate: "February 23",
        unsubscribeUrl: "https://app.wopr.bot/settings/notifications",
        creditsUrl: "https://app.wopr.bot/billing/credits",
      });

      expect(result.subject).toBe("WOPR paid you $3.50 this week");
      expect(result.html).toContain("$3.50");
      expect(result.html).toContain("$42.00");
      expect(result.html).toContain("February 17");
      expect(result.html).toContain("February 23");
      expect(result.html).toContain("Unsubscribe");
      expect(result.text).toContain("$3.50");
      expect(result.text).toContain("Unsubscribe");
    });
  });

  describe("XSS protection", () => {
    it("escapes HTML in user-supplied fields like agentName", () => {
      const result = renderNotificationTemplate("agent-created", {
        email: "user@example.com",
        agentName: '<img src=x onerror="alert(1)">',
      });
      expect(result.html).not.toContain("<img");
      expect(result.html).toContain("&lt;img");
    });

    it("escapes HTML in reason fields", () => {
      const result = renderNotificationTemplate("admin-suspended", {
        email: "user@example.com",
        reason: "<script>evil()</script>",
      });
      expect(result.html).not.toContain("<script>");
    });
  });
});
