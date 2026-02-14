import { beforeEach, describe, expect, it, vi } from "vitest";
import { EmailClient, getEmailClient, resetEmailClient, setEmailClient } from "./client.js";

const mockSend = vi.fn();

vi.mock("resend", () => ({
  Resend: class MockResend {
    emails = { send: mockSend };
  },
}));

vi.mock("../config/logger.js", () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

describe("EmailClient", () => {
  let client: EmailClient;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockResolvedValue({ data: { id: "email-123" }, error: null });
    client = new EmailClient({
      apiKey: "test-api-key",
      from: "noreply@wopr.bot",
      replyTo: "support@wopr.bot",
    });
  });

  it("should send email with correct parameters", async () => {
    const result = await client.send({
      to: "user@test.com",
      subject: "Test Subject",
      html: "<p>Test</p>",
      text: "Test",
    });

    expect(result).toEqual({ id: "email-123", success: true });
    expect(mockSend).toHaveBeenCalledWith({
      from: "noreply@wopr.bot",
      replyTo: "support@wopr.bot",
      to: "user@test.com",
      subject: "Test Subject",
      html: "<p>Test</p>",
      text: "Test",
    });
  });

  it("should throw on Resend API error", async () => {
    mockSend.mockResolvedValueOnce({ data: null, error: { message: "Rate limit" } });

    await expect(client.send({ to: "user@test.com", subject: "Test", html: "<p>T</p>", text: "T" })).rejects.toThrow(
      "Failed to send email: Rate limit",
    );
  });

  it("should invoke onEmailSent callback after successful send", async () => {
    const callback = vi.fn();
    client.onEmailSent(callback);

    const result = await client.send({
      to: "user@test.com",
      subject: "Test",
      html: "<p>T</p>",
      text: "T",
      userId: "user-1",
      templateName: "verify-email",
    });

    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({ to: "user@test.com", templateName: "verify-email" }),
      result,
    );
  });

  it("should not throw if onEmailSent callback errors", async () => {
    const callback = vi.fn().mockImplementation(() => {
      throw new Error("callback failed");
    });
    client.onEmailSent(callback);

    const result = await client.send({
      to: "user@test.com",
      subject: "Test",
      html: "<p>T</p>",
      text: "T",
    });

    expect(result.success).toBe(true);
    expect(callback).toHaveBeenCalled();
  });

  it("should handle empty id from Resend", async () => {
    mockSend.mockResolvedValueOnce({ data: { id: undefined }, error: null });

    const result = await client.send({
      to: "user@test.com",
      subject: "Test",
      html: "<p>T</p>",
      text: "T",
    });

    expect(result).toEqual({ id: "", success: true });
  });
});

describe("getEmailClient / setEmailClient / resetEmailClient", () => {
  beforeEach(() => {
    resetEmailClient();
    delete process.env.RESEND_API_KEY;
    delete process.env.RESEND_FROM;
    delete process.env.RESEND_REPLY_TO;
  });

  it("should throw if RESEND_API_KEY is not set", () => {
    expect(() => getEmailClient()).toThrow("RESEND_API_KEY environment variable is required");
  });

  it("should create client from env vars", () => {
    process.env.RESEND_API_KEY = "re_test123";
    const client = getEmailClient();
    expect(client).toBeInstanceOf(EmailClient);
  });

  it("should return singleton", () => {
    process.env.RESEND_API_KEY = "re_test123";
    const a = getEmailClient();
    const b = getEmailClient();
    expect(a).toBe(b);
  });

  it("should allow replacing singleton for testing", () => {
    const mock = new EmailClient({ apiKey: "mock", from: "mock@test.com" });
    setEmailClient(mock);
    expect(getEmailClient()).toBe(mock);
  });

  it("should reset singleton", () => {
    process.env.RESEND_API_KEY = "re_test123";
    const a = getEmailClient();
    resetEmailClient();
    const b = getEmailClient();
    expect(a).not.toBe(b);
  });
});
