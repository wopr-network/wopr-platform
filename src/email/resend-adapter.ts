/**
 * Resend Email Adapter for Better Auth
 *
 * Provides transactional email capability for Better Auth password reset flows.
 * Uses Resend API for email delivery.
 */

import { Resend } from "resend";

export interface EmailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

/**
 * Escape HTML special characters to prevent XSS.
 *
 * @param str - String to escape
 * @returns Escaped string safe for HTML interpolation
 */
export function escapeHtml(str: string): string {
  const map: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };
  return str.replace(/[&<>"']/g, (char) => map[char] || char);
}

/**
 * Send an email using Resend.
 *
 * @param options - Email configuration (to, subject, html, text)
 * @param apiKey - Resend API key (defaults to RESEND_API_KEY env var)
 * @param from - Sender email address (defaults to RESEND_FROM_EMAIL env var)
 * @returns Resend response
 */
export async function sendEmail(
  options: EmailOptions,
  apiKey?: string,
  from?: string,
): Promise<{ id: string; success: boolean }> {
  const key = apiKey || process.env.RESEND_API_KEY;
  if (!key) {
    throw new Error("RESEND_API_KEY environment variable is required");
  }

  const fromEmail = from || process.env.RESEND_FROM_EMAIL || "noreply@wopr.network";
  const resend = new Resend(key);

  const { data, error } = await resend.emails.send({
    from: fromEmail,
    to: options.to,
    subject: options.subject,
    html: options.html,
    text: options.text,
  });

  if (error) {
    throw new Error(`Failed to send email: ${error.message}`);
  }

  return {
    id: data?.id || "",
    success: true,
  };
}

/**
 * Generate password reset email HTML template.
 *
 * @param resetUrl - The password reset URL with token
 * @param email - User's email address
 * @returns HTML email content
 */
export function passwordResetTemplate(resetUrl: string, email: string): string {
  const escapedEmail = escapeHtml(email);
  const escapedResetUrl = escapeHtml(resetUrl);
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Reset Your Password</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f4f4f4;">
  <table role="presentation" style="width: 100%; border-collapse: collapse;">
    <tr>
      <td style="padding: 40px 0; text-align: center;">
        <table role="presentation" style="width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
          <tr>
            <td style="padding: 40px 40px 20px 40px; text-align: center;">
              <h1 style="margin: 0; font-size: 24px; font-weight: 600; color: #1a1a1a;">Reset Your Password</h1>
            </td>
          </tr>
          <tr>
            <td style="padding: 0 40px 20px 40px; color: #4a5568; font-size: 16px; line-height: 24px;">
              <p>Hi there,</p>
              <p>You requested a password reset for your WOPR account (<strong>${escapedEmail}</strong>).</p>
              <p>Click the button below to create a new password. This link will expire in 1 hour.</p>
            </td>
          </tr>
          <tr>
            <td style="padding: 0 40px 30px 40px; text-align: center;">
              <a href="${resetUrl}" style="display: inline-block; padding: 12px 32px; background-color: #2563eb; color: #ffffff; text-decoration: none; font-weight: 600; border-radius: 6px; font-size: 16px;">Reset Password</a>
            </td>
          </tr>
          <tr>
            <td style="padding: 0 40px 20px 40px; color: #718096; font-size: 14px; line-height: 20px;">
              <p>Or copy and paste this URL into your browser:</p>
              <p style="word-break: break-all; color: #2563eb;">${escapedResetUrl}</p>
            </td>
          </tr>
          <tr>
            <td style="padding: 0 40px 40px 40px; color: #718096; font-size: 14px; line-height: 20px; border-top: 1px solid #e2e8f0;">
              <p style="margin-top: 20px;">If you didn't request this password reset, you can safely ignore this email.</p>
            </td>
          </tr>
        </table>
        <p style="margin-top: 20px; color: #a0aec0; font-size: 12px;">© ${new Date().getFullYear()} WOPR Network. All rights reserved.</p>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();
}

/**
 * Generate plain text version of password reset email.
 *
 * @param resetUrl - The password reset URL with token
 * @param email - User's email address
 * @returns Plain text email content
 */
export function passwordResetText(resetUrl: string, email: string): string {
  return `
Reset Your Password

Hi there,

You requested a password reset for your WOPR account (${email}).

Click the link below to create a new password. This link will expire in 1 hour.

${resetUrl}

If you didn't request this password reset, you can safely ignore this email.

© ${new Date().getFullYear()} WOPR Network. All rights reserved.
  `.trim();
}
