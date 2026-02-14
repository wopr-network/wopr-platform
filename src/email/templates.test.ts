import { describe, expect, it } from "vitest";
import {
  botDestructionTemplate,
  botSuspendedTemplate,
  creditPurchaseTemplate,
  lowBalanceTemplate,
  passwordResetEmailTemplate,
  verifyEmailTemplate,
  welcomeTemplate,
} from "./templates.js";

describe("verifyEmailTemplate", () => {
  it("should generate HTML and text with verify URL", () => {
    const result = verifyEmailTemplate("https://wopr.bot/auth/verify?token=abc123", "user@test.com");

    expect(result.subject).toBe("Verify your WOPR account");
    expect(result.html).toContain("Verify Your Email");
    expect(result.html).toContain("https://wopr.bot/auth/verify?token=abc123");
    expect(result.html).toContain("user@test.com");
    expect(result.html).toContain("<!DOCTYPE html>");
    expect(result.text).toContain("https://wopr.bot/auth/verify?token=abc123");
    expect(result.text).toContain("user@test.com");
    expect(result.text).not.toContain("<");
  });

  it("should escape HTML in email and URL", () => {
    const result = verifyEmailTemplate("https://evil.com/<script>", "<script>alert('xss')</script>@evil.com");

    expect(result.html).toContain("&lt;script&gt;alert(&#39;xss&#39;)&lt;/script&gt;@evil.com");
    expect(result.html).toContain("&lt;script&gt;");
  });

  it("should include 24-hour expiry notice", () => {
    const result = verifyEmailTemplate("https://wopr.bot/verify?token=x", "a@b.com");
    expect(result.html).toContain("24 hours");
    expect(result.text).toContain("24 hours");
  });
});

describe("welcomeTemplate", () => {
  it("should generate welcome email with credit info", () => {
    const result = welcomeTemplate("user@test.com");

    expect(result.subject).toBe("Welcome to WOPR");
    expect(result.html).toContain("Welcome to WOPR");
    expect(result.html).toContain("$5.00 in free credits");
    expect(result.html).toContain("user@test.com");
    expect(result.text).toContain("$5.00 in free credits");
    expect(result.text).not.toContain("<");
  });
});

describe("passwordResetEmailTemplate", () => {
  it("should generate password reset email", () => {
    const result = passwordResetEmailTemplate("https://wopr.bot/reset?token=abc", "user@test.com");

    expect(result.subject).toBe("Reset your WOPR password");
    expect(result.html).toContain("Reset Your Password");
    expect(result.html).toContain("https://wopr.bot/reset?token=abc");
    expect(result.html).toContain("1 hour");
    expect(result.text).toContain("https://wopr.bot/reset?token=abc");
    expect(result.text).not.toContain("<");
  });
});

describe("creditPurchaseTemplate", () => {
  it("should generate credit purchase confirmation", () => {
    const result = creditPurchaseTemplate("user@test.com", "$10.00");

    expect(result.subject).toBe("Credits added to your account");
    expect(result.html).toContain("$10.00");
    expect(result.html).toContain("Credits Added");
    expect(result.text).toContain("$10.00");
  });
});

describe("lowBalanceTemplate", () => {
  it("should generate low balance warning", () => {
    const result = lowBalanceTemplate("user@test.com", "$0.50");

    expect(result.subject).toBe("Your WOPR credits are running low");
    expect(result.html).toContain("$0.50");
    expect(result.html).toContain("Running Low");
    expect(result.text).toContain("$0.50");
    expect(result.text).toContain("paused");
  });
});

describe("botSuspendedTemplate", () => {
  it("should generate bot suspended notification", () => {
    const result = botSuspendedTemplate("user@test.com", "MyBot", "Terms of service violation");

    expect(result.subject).toBe("Your bot has been suspended");
    expect(result.html).toContain("MyBot");
    expect(result.html).toContain("Terms of service violation");
    expect(result.text).toContain("MyBot");
    expect(result.text).toContain("Terms of service violation");
  });

  it("should escape HTML in bot name and reason", () => {
    const result = botSuspendedTemplate("user@test.com", "<script>bot</script>", "<b>reason</b>");

    expect(result.html).toContain("&lt;script&gt;bot&lt;/script&gt;");
    expect(result.html).toContain("&lt;b&gt;reason&lt;/b&gt;");
  });
});

describe("botDestructionTemplate", () => {
  it("should generate bot destruction warning with days", () => {
    const result = botDestructionTemplate("user@test.com", "MyBot", 7);

    expect(result.subject).toBe("Your bot data will be deleted in 7 days");
    expect(result.html).toContain("MyBot");
    expect(result.html).toContain("7 days");
    expect(result.html).toContain("permanently deleted");
    expect(result.text).toContain("7 days");
    expect(result.text).toContain("irreversible");
  });
});

describe("all templates", () => {
  it("should produce valid HTML structure for every template", () => {
    const templates = [
      verifyEmailTemplate("https://x.com/verify", "a@b.com"),
      welcomeTemplate("a@b.com"),
      passwordResetEmailTemplate("https://x.com/reset", "a@b.com"),
      creditPurchaseTemplate("a@b.com", "$5"),
      lowBalanceTemplate("a@b.com", "$0.50"),
      botSuspendedTemplate("a@b.com", "Bot", "Reason"),
      botDestructionTemplate("a@b.com", "Bot", 3),
    ];

    for (const t of templates) {
      expect(t.html).toContain("<!DOCTYPE html>");
      expect(t.html).toContain("<html>");
      expect(t.html).toContain("</html>");
      expect(t.html).toContain("WOPR Network");
      expect(t.subject.length).toBeGreaterThan(0);
      expect(t.text.length).toBeGreaterThan(0);
    }
  });

  it("should produce plain text without HTML tags for every template", () => {
    const templates = [
      verifyEmailTemplate("https://x.com/verify", "a@b.com"),
      welcomeTemplate("a@b.com"),
      passwordResetEmailTemplate("https://x.com/reset", "a@b.com"),
      creditPurchaseTemplate("a@b.com", "$5"),
      lowBalanceTemplate("a@b.com", "$0.50"),
      botSuspendedTemplate("a@b.com", "Bot", "Reason"),
      botDestructionTemplate("a@b.com", "Bot", 3),
    ];

    for (const t of templates) {
      expect(t.text).not.toMatch(/<[a-z]/i);
    }
  });
});
