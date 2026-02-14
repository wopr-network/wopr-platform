/**
 * Email Client — Template-based transactional email sender.
 *
 * Wraps Resend SDK and provides a typed interface for sending emails
 * using the platform's templates. Every email is logged for audit.
 */

import { Resend } from "resend";
import { logger } from "../config/logger.js";

export interface EmailClientConfig {
  apiKey: string;
  from: string;
  replyTo?: string;
}

export interface SendTemplateEmailOpts {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Audit metadata: who triggered this email */
  userId?: string;
  /** Audit metadata: which template was used */
  templateName?: string;
}

export interface EmailSendResult {
  id: string;
  success: boolean;
}

/**
 * Transactional email client backed by Resend.
 *
 * Usage:
 * ```ts
 * const client = new EmailClient({ apiKey: "re_xxx", from: "noreply@wopr.bot" });
 * const template = verifyEmailTemplate(url, email);
 * await client.send({ to: email, ...template, userId: "user-123", templateName: "verify-email" });
 * ```
 */
export class EmailClient {
  private resend: Resend;
  private from: string;
  private replyTo: string | undefined;
  private onSend: ((opts: SendTemplateEmailOpts, result: EmailSendResult) => void) | null = null;

  constructor(config: EmailClientConfig) {
    this.resend = new Resend(config.apiKey);
    this.from = config.from;
    this.replyTo = config.replyTo;
  }

  /** Register a callback invoked after each successful send (for audit logging). */
  onEmailSent(callback: (opts: SendTemplateEmailOpts, result: EmailSendResult) => void): void {
    this.onSend = callback;
  }

  /** Send a transactional email. */
  async send(opts: SendTemplateEmailOpts): Promise<EmailSendResult> {
    const { data, error } = await this.resend.emails.send({
      from: this.from,
      replyTo: this.replyTo,
      to: opts.to,
      subject: opts.subject,
      html: opts.html,
      text: opts.text,
    });

    if (error) {
      logger.error("Failed to send email", {
        to: opts.to,
        template: opts.templateName,
        error: error.message,
      });
      throw new Error(`Failed to send email: ${error.message}`);
    }

    const result: EmailSendResult = {
      id: data?.id || "",
      success: true,
    };

    logger.info("Email sent", {
      emailId: result.id,
      to: opts.to,
      template: opts.templateName,
      userId: opts.userId,
    });

    if (this.onSend) {
      try {
        this.onSend(opts, result);
      } catch {
        // Audit callback failure should not break email sending
      }
    }

    return result;
  }
}

/**
 * Create a lazily-initialized singleton EmailClient from environment variables.
 *
 * Env vars:
 * - RESEND_API_KEY (required)
 * - RESEND_FROM (default: "noreply@wopr.bot")
 * - RESEND_REPLY_TO (default: "support@wopr.bot")
 */
let _client: EmailClient | null = null;

export function getEmailClient(): EmailClient {
  if (!_client) {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      throw new Error("RESEND_API_KEY environment variable is required");
    }
    _client = new EmailClient({
      apiKey,
      from: process.env.RESEND_FROM || "noreply@wopr.bot",
      replyTo: process.env.RESEND_REPLY_TO || "support@wopr.bot",
    });
  }
  return _client;
}

/** Reset the singleton (for testing). */
export function resetEmailClient(): void {
  _client = null;
}

/** Replace the singleton (for testing). */
export function setEmailClient(client: EmailClient): void {
  _client = client;
}
