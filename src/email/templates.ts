/**
 * Email Templates — HTML and plain text templates for all transactional emails.
 *
 * Each template has an HTML and a plain text version. HTML uses inline styles
 * for maximum email client compatibility. All user-supplied values are escaped
 * to prevent XSS.
 */

import { escapeHtml } from "./resend-adapter.js";

// ---------------------------------------------------------------------------
// Shared layout helpers
// ---------------------------------------------------------------------------

function wrapHtml(title: string, bodyContent: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f4f4f4;">
  <table role="presentation" style="width: 100%; border-collapse: collapse;">
    <tr>
      <td style="padding: 40px 0; text-align: center;">
        <table role="presentation" style="width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
          ${bodyContent}
        </table>
        <p style="margin-top: 20px; color: #a0aec0; font-size: 12px;">&copy; ${new Date().getFullYear()} WOPR Network. All rights reserved.</p>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function heading(text: string): string {
  return `<tr>
  <td style="padding: 40px 40px 20px 40px; text-align: center;">
    <h1 style="margin: 0; font-size: 24px; font-weight: 600; color: #1a1a1a;">${escapeHtml(text)}</h1>
  </td>
</tr>`;
}

function paragraph(html: string): string {
  return `<tr>
  <td style="padding: 0 40px 20px 40px; color: #4a5568; font-size: 16px; line-height: 24px;">
    ${html}
  </td>
</tr>`;
}

function button(url: string, label: string, color = "#2563eb"): string {
  return `<tr>
  <td style="padding: 0 40px 30px 40px; text-align: center;">
    <a href="${url}" style="display: inline-block; padding: 12px 32px; background-color: ${color}; color: #ffffff; text-decoration: none; font-weight: 600; border-radius: 6px; font-size: 16px;">${escapeHtml(label)}</a>
  </td>
</tr>`;
}

function footer(text: string): string {
  return `<tr>
  <td style="padding: 0 40px 40px 40px; color: #718096; font-size: 14px; line-height: 20px; border-top: 1px solid #e2e8f0;">
    <p style="margin-top: 20px;">${text}</p>
  </td>
</tr>`;
}

// ---------------------------------------------------------------------------
// Template types
// ---------------------------------------------------------------------------

export type TemplateName =
  | "verify-email"
  | "welcome"
  | "password-reset"
  | "credit-purchase"
  | "low-balance"
  | "bot-suspended"
  | "bot-destruction";

export interface TemplateResult {
  subject: string;
  html: string;
  text: string;
}

// ---------------------------------------------------------------------------
// 1. Verify Email
// ---------------------------------------------------------------------------

export function verifyEmailTemplate(verifyUrl: string, email: string): TemplateResult {
  const escapedEmail = escapeHtml(email);
  const escapedUrl = escapeHtml(verifyUrl);

  const html = wrapHtml(
    "Verify Your Email",
    [
      heading("Verify Your Email"),
      paragraph(`<p>Thanks for signing up for WOPR! Please verify your email address (<strong>${escapedEmail}</strong>) to activate your account.</p>
    <p>Click the button below to verify. This link will expire in 24 hours.</p>`),
      button(verifyUrl, "Verify Email"),
      paragraph(`<p style="color: #718096; font-size: 14px;">Or copy and paste this URL into your browser:</p>
    <p style="word-break: break-all; color: #2563eb; font-size: 14px;">${escapedUrl}</p>`),
      footer("If you didn't create a WOPR account, you can safely ignore this email."),
    ].join("\n"),
  );

  const text = `Verify Your Email

Thanks for signing up for WOPR! Please verify your email address (${email}) to activate your account.

Click the link below to verify. This link will expire in 24 hours.

${verifyUrl}

If you didn't create a WOPR account, you can safely ignore this email.

(c) ${new Date().getFullYear()} WOPR Network. All rights reserved.`;

  return { subject: "Verify your WOPR account", html, text };
}

// ---------------------------------------------------------------------------
// 2. Welcome
// ---------------------------------------------------------------------------

export function welcomeTemplate(email: string): TemplateResult {
  const escapedEmail = escapeHtml(email);

  const html = wrapHtml(
    "Welcome to WOPR",
    [
      heading("Welcome to WOPR!"),
      paragraph(`<p>Hi <strong>${escapedEmail}</strong>,</p>
    <p>Your email has been verified and your account is now active. You've been granted <strong>$5.00 in free credits</strong> to get started.</p>
    <p>You can now create bots, connect them to Discord, Slack, and more.</p>`),
      footer("Happy building!"),
    ].join("\n"),
  );

  const text = `Welcome to WOPR!

Hi ${email},

Your email has been verified and your account is now active. You've been granted $5.00 in free credits to get started.

You can now create bots, connect them to Discord, Slack, and more.

Happy building!

(c) ${new Date().getFullYear()} WOPR Network. All rights reserved.`;

  return { subject: "Welcome to WOPR", html, text };
}

// ---------------------------------------------------------------------------
// 3. Password Reset (supersedes WOP-346 inline template)
// ---------------------------------------------------------------------------

export function passwordResetEmailTemplate(resetUrl: string, email: string): TemplateResult {
  const escapedEmail = escapeHtml(email);
  const escapedUrl = escapeHtml(resetUrl);

  const html = wrapHtml(
    "Reset Your Password",
    [
      heading("Reset Your Password"),
      paragraph(`<p>Hi there,</p>
    <p>You requested a password reset for your WOPR account (<strong>${escapedEmail}</strong>).</p>
    <p>Click the button below to create a new password. This link will expire in 1 hour.</p>`),
      button(resetUrl, "Reset Password"),
      paragraph(`<p style="color: #718096; font-size: 14px;">Or copy and paste this URL into your browser:</p>
    <p style="word-break: break-all; color: #2563eb; font-size: 14px;">${escapedUrl}</p>`),
      footer("If you didn't request this password reset, you can safely ignore this email."),
    ].join("\n"),
  );

  const text = `Reset Your Password

Hi there,

You requested a password reset for your WOPR account (${email}).

Click the link below to create a new password. This link will expire in 1 hour.

${resetUrl}

If you didn't request this password reset, you can safely ignore this email.

(c) ${new Date().getFullYear()} WOPR Network. All rights reserved.`;

  return { subject: "Reset your WOPR password", html, text };
}

// ---------------------------------------------------------------------------
// 4. Credit Purchase
// ---------------------------------------------------------------------------

export function creditPurchaseTemplate(email: string, amountDollars: string): TemplateResult {
  const escapedEmail = escapeHtml(email);
  const escapedAmount = escapeHtml(amountDollars);

  const html = wrapHtml(
    "Credits Added",
    [
      heading("Credits Added to Your Account"),
      paragraph(`<p>Hi <strong>${escapedEmail}</strong>,</p>
    <p><strong>${escapedAmount}</strong> in credits has been added to your WOPR account. Your updated balance is now available in your dashboard.</p>`),
      footer("Thank you for supporting WOPR!"),
    ].join("\n"),
  );

  const text = `Credits Added to Your Account

Hi ${email},

${amountDollars} in credits has been added to your WOPR account. Your updated balance is now available in your dashboard.

Thank you for supporting WOPR!

(c) ${new Date().getFullYear()} WOPR Network. All rights reserved.`;

  return { subject: "Credits added to your account", html, text };
}

// ---------------------------------------------------------------------------
// 5. Low Balance
// ---------------------------------------------------------------------------

export function lowBalanceTemplate(email: string, balanceDollars: string): TemplateResult {
  const escapedEmail = escapeHtml(email);
  const escapedBalance = escapeHtml(balanceDollars);

  const html = wrapHtml(
    "Low Balance",
    [
      heading("Your WOPR Credits Are Running Low"),
      paragraph(`<p>Hi <strong>${escapedEmail}</strong>,</p>
    <p>Your WOPR credit balance is now <strong>${escapedBalance}</strong>. When your balance reaches $0, your bots will be paused.</p>
    <p>Top up your credits to keep your bots running.</p>`),
      footer("This is an automated notification based on your account balance."),
    ].join("\n"),
  );

  const text = `Your WOPR Credits Are Running Low

Hi ${email},

Your WOPR credit balance is now ${balanceDollars}. When your balance reaches $0, your bots will be paused.

Top up your credits to keep your bots running.

(c) ${new Date().getFullYear()} WOPR Network. All rights reserved.`;

  return { subject: "Your WOPR credits are running low", html, text };
}

// ---------------------------------------------------------------------------
// 6. Bot Suspended
// ---------------------------------------------------------------------------

export function botSuspendedTemplate(email: string, botName: string, reason: string): TemplateResult {
  const escapedEmail = escapeHtml(email);
  const escapedBotName = escapeHtml(botName);
  const escapedReason = escapeHtml(reason);

  const html = wrapHtml(
    "Bot Suspended",
    [
      heading("Your Bot Has Been Suspended"),
      paragraph(`<p>Hi <strong>${escapedEmail}</strong>,</p>
    <p>Your bot <strong>${escapedBotName}</strong> has been suspended.</p>
    <p><strong>Reason:</strong> ${escapedReason}</p>
    <p>Please review the issue and take corrective action. You can contact support if you believe this was in error.</p>`),
      footer("If you need help, reply to this email or contact support@wopr.bot."),
    ].join("\n"),
  );

  const text = `Your Bot Has Been Suspended

Hi ${email},

Your bot "${botName}" has been suspended.

Reason: ${reason}

Please review the issue and take corrective action. You can contact support if you believe this was in error.

(c) ${new Date().getFullYear()} WOPR Network. All rights reserved.`;

  return { subject: "Your bot has been suspended", html, text };
}

// ---------------------------------------------------------------------------
// 7. Bot Destruction Warning
// ---------------------------------------------------------------------------

export function botDestructionTemplate(email: string, botName: string, daysRemaining: number): TemplateResult {
  const escapedEmail = escapeHtml(email);
  const escapedBotName = escapeHtml(botName);
  const days = String(daysRemaining);

  const html = wrapHtml(
    "Bot Data Deletion",
    [
      heading("Bot Data Will Be Deleted"),
      paragraph(`<p>Hi <strong>${escapedEmail}</strong>,</p>
    <p>Your bot <strong>${escapedBotName}</strong> has been suspended and its data will be permanently deleted in <strong>${escapeHtml(days)} days</strong>.</p>
    <p>To prevent data loss, please resolve the suspension before the deadline.</p>`),
      footer("This action is irreversible. All bot configuration, history, and connected services will be removed."),
    ].join("\n"),
  );

  const text = `Bot Data Will Be Deleted

Hi ${email},

Your bot "${botName}" has been suspended and its data will be permanently deleted in ${daysRemaining} days.

To prevent data loss, please resolve the suspension before the deadline.

This action is irreversible. All bot configuration, history, and connected services will be removed.

(c) ${new Date().getFullYear()} WOPR Network. All rights reserved.`;

  return { subject: `Your bot data will be deleted in ${daysRemaining} days`, html, text };
}
