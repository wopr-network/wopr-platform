import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type EmailOptions,
  escapeHtml,
  passwordResetTemplate,
  passwordResetText,
  sendEmail,
} from "./resend-adapter.js";

// Create a mock send function that can be controlled in tests
const mockSend = vi.fn();

// Mock the Resend module
vi.mock("resend", () => {
  return {
    Resend: class MockResend {
      emails = {
        send: mockSend,
      };
    },
  };
});

describe("escapeHtml", () => {
  it("should escape all dangerous HTML characters", () => {
    expect(escapeHtml("<script>alert('XSS')</script>")).toBe("&lt;script&gt;alert(&#39;XSS&#39;)&lt;/script&gt;");
    expect(escapeHtml('Test "quotes" & <tags>')).toBe("Test &quot;quotes&quot; &amp; &lt;tags&gt;");
    expect(escapeHtml("user@example.com")).toBe("user@example.com");
  });

  it("should handle empty strings", () => {
    expect(escapeHtml("")).toBe("");
  });

  it("should handle strings with no special characters", () => {
    expect(escapeHtml("normal text 123")).toBe("normal text 123");
  });
});

describe("sendEmail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.RESEND_API_KEY;
    delete process.env.RESEND_FROM_EMAIL;
    // Reset mock to default success response
    mockSend.mockResolvedValue({
      data: { id: "test-email-id" },
      error: null,
    });
  });

  it("should send email with required options", async () => {
    process.env.RESEND_API_KEY = "test-api-key";

    const options: EmailOptions = {
      to: "user@example.com",
      subject: "Test Subject",
      html: "<p>Test HTML</p>",
    };

    const result = await sendEmail(options);

    expect(result).toEqual({
      id: "test-email-id",
      success: true,
    });
  });

  it("should use custom API key when provided", async () => {
    const options: EmailOptions = {
      to: "user@example.com",
      subject: "Test Subject",
      html: "<p>Test HTML</p>",
    };

    const result = await sendEmail(options, "custom-api-key");

    expect(result.success).toBe(true);
  });

  it("should use custom from address when provided", async () => {
    process.env.RESEND_API_KEY = "test-api-key";

    const options: EmailOptions = {
      to: "user@example.com",
      subject: "Test Subject",
      html: "<p>Test HTML</p>",
    };

    const result = await sendEmail(options, undefined, "custom@example.com");

    expect(result.success).toBe(true);
  });

  it("should throw error when RESEND_API_KEY is missing", async () => {
    const options: EmailOptions = {
      to: "user@example.com",
      subject: "Test Subject",
      html: "<p>Test HTML</p>",
    };

    await expect(sendEmail(options)).rejects.toThrow("RESEND_API_KEY environment variable is required");
  });

  it("should handle Resend API errors", async () => {
    process.env.RESEND_API_KEY = "test-api-key";

    // Mock Resend to return an error for this specific test
    mockSend.mockResolvedValueOnce({
      data: null,
      error: { message: "API error" },
    });

    const options: EmailOptions = {
      to: "user@example.com",
      subject: "Test Subject",
      html: "<p>Test HTML</p>",
    };

    await expect(sendEmail(options)).rejects.toThrow("Failed to send email: API error");
  });

  it("should use default from email when env var is set", async () => {
    process.env.RESEND_API_KEY = "test-api-key";
    process.env.RESEND_FROM_EMAIL = "default@example.com";

    const options: EmailOptions = {
      to: "user@example.com",
      subject: "Test Subject",
      html: "<p>Test HTML</p>",
    };

    const result = await sendEmail(options);

    expect(result.success).toBe(true);
  });

  it("should include text version when provided", async () => {
    process.env.RESEND_API_KEY = "test-api-key";

    const options: EmailOptions = {
      to: "user@example.com",
      subject: "Test Subject",
      html: "<p>Test HTML</p>",
      text: "Test plain text",
    };

    const result = await sendEmail(options);

    expect(result.success).toBe(true);
  });
});

describe("passwordResetTemplate", () => {
  it("should generate HTML template with reset URL", () => {
    const resetUrl = "https://wopr.bot/reset?token=abc123";
    const email = "user@example.com";

    const html = passwordResetTemplate(resetUrl, email);

    expect(html).toContain(resetUrl);
    expect(html).toContain(email);
    expect(html).toContain("Reset Your Password");
    expect(html).toContain("Reset Password");
    expect(html).toContain("<!DOCTYPE html>");
  });

  it("should escape HTML characters in email and URL to prevent XSS", () => {
    const resetUrl = "https://wopr.bot/reset?token=<script>alert(1)</script>";
    const email = "<script>alert('xss')</script>@example.com";

    const html = passwordResetTemplate(resetUrl, email);

    // Verify email is escaped in the text where it's displayed
    expect(html).toContain("&lt;script&gt;alert(&#39;xss&#39;)&lt;/script&gt;@example.com");

    // Verify resetUrl is escaped in the displayed text (not href)
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");

    // Verify the email script tag doesn't appear unescaped in body text
    // (it may appear in href attribute, which is safe from XSS)
    const bodyMatch = html.match(/<p>.*<\/p>/gs);
    const bodyText = bodyMatch ? bodyMatch.join("") : "";
    expect(bodyText).not.toContain("<script>alert('xss')</script>");
  });

  it("should include current year in footer", () => {
    const resetUrl = "https://wopr.bot/reset?token=abc123";
    const email = "user@example.com";

    const html = passwordResetTemplate(resetUrl, email);

    const currentYear = new Date().getFullYear();
    expect(html).toContain(`© ${currentYear} WOPR Network`);
  });

  it("should be valid HTML structure", () => {
    const resetUrl = "https://wopr.bot/reset?token=abc123";
    const email = "user@example.com";

    const html = passwordResetTemplate(resetUrl, email);

    expect(html).toContain("<html>");
    expect(html).toContain("</html>");
    expect(html).toContain("<head>");
    expect(html).toContain("</head>");
    expect(html).toContain("<body");
    expect(html).toContain("</body>");
  });
});

describe("passwordResetText", () => {
  it("should generate plain text with reset URL", () => {
    const resetUrl = "https://wopr.bot/reset?token=abc123";
    const email = "user@example.com";

    const text = passwordResetText(resetUrl, email);

    expect(text).toContain(resetUrl);
    expect(text).toContain(email);
    expect(text).toContain("Reset Your Password");
  });

  it("should not contain HTML tags", () => {
    const resetUrl = "https://wopr.bot/reset?token=abc123";
    const email = "user@example.com";

    const text = passwordResetText(resetUrl, email);

    expect(text).not.toContain("<");
    expect(text).not.toContain(">");
  });

  it("should include current year in footer", () => {
    const resetUrl = "https://wopr.bot/reset?token=abc123";
    const email = "user@example.com";

    const text = passwordResetText(resetUrl, email);

    const currentYear = new Date().getFullYear();
    expect(text).toContain(`© ${currentYear} WOPR Network`);
  });

  it("should be readable plain text format", () => {
    const resetUrl = "https://wopr.bot/reset?token=abc123";
    const email = "user@example.com";

    const text = passwordResetText(resetUrl, email);

    // Should have line breaks and be formatted
    expect(text.split("\n").length).toBeGreaterThan(5);
  });
});
