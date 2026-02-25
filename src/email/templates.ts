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
    <a href="${escapeHtml(url)}" style="display: inline-block; padding: 12px 32px; background-color: ${color}; color: #ffffff; text-decoration: none; font-weight: 600; border-radius: 6px; font-size: 16px;">${escapeHtml(label)}</a>
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

function unsubscribeFooter(unsubscribeUrl?: string): string {
  if (!unsubscribeUrl) return "";
  return `<tr>
  <td style="padding: 0 40px 20px 40px; text-align: center; color: #a0aec0; font-size: 12px;">
    <a href="${escapeHtml(unsubscribeUrl)}" style="color: #a0aec0; text-decoration: underline;">Unsubscribe from billing notifications</a>
  </td>
</tr>`;
}

function unsubscribeText(unsubscribeUrl?: string): string {
  if (!unsubscribeUrl) return "";
  return `\n\nTo unsubscribe from billing notifications: ${unsubscribeUrl}`;
}

/** Build the unsubscribe URL from a creditsUrl by deriving the origin. */
function buildUnsubscribeUrl(creditsUrl: string): string {
  try {
    const base = new URL(creditsUrl);
    return `${base.origin}/settings/notifications`;
  } catch {
    // If creditsUrl is not a valid absolute URL, fall back to simple concatenation.
    return `${creditsUrl.replace(/\/+$/, "").split("/").slice(0, 3).join("/")}/settings/notifications`;
  }
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
  | "bot-destruction"
  | "data-deleted";

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

export function creditPurchaseTemplate(
  email: string,
  amountDollars: string,
  newBalanceDollars?: string,
  creditsUrl?: string,
): TemplateResult {
  const escapedEmail = escapeHtml(email);
  const escapedAmount = escapeHtml(amountDollars);
  const balanceLine = newBalanceDollars
    ? `<p>Your new balance is <strong>${escapeHtml(newBalanceDollars)}</strong>.</p>`
    : "<p>Your updated balance is now available in your dashboard.</p>";
  const balanceTextLine = newBalanceDollars
    ? `Your new balance is ${newBalanceDollars}.`
    : "Your updated balance is now available in your dashboard.";

  const parts = [
    heading("Credits Added to Your Account"),
    paragraph(`<p>Hi <strong>${escapedEmail}</strong>,</p>
    <p><strong>${escapedAmount}</strong> in credits has been added to your WOPR account.</p>
    ${balanceLine}`),
  ];
  if (creditsUrl) parts.push(button(creditsUrl, "View Credits"));
  parts.push(footer("Thank you for supporting WOPR!"));
  parts.push(unsubscribeFooter(creditsUrl ? buildUnsubscribeUrl(creditsUrl) : undefined));

  const html = wrapHtml("Credits Added", parts.join("\n"));

  const text = `Credits Added to Your Account

Hi ${email},

${amountDollars} in credits has been added to your WOPR account.
${balanceTextLine}
${creditsUrl ? `\nView your credits: ${creditsUrl}` : ""}
Thank you for supporting WOPR!${unsubscribeText(creditsUrl ? buildUnsubscribeUrl(creditsUrl) : undefined)}

(c) ${new Date().getFullYear()} WOPR Network. All rights reserved.`;

  return { subject: "Credits added to your account", html, text };
}

// ---------------------------------------------------------------------------
// 5. Low Balance
// ---------------------------------------------------------------------------

export function lowBalanceTemplate(
  email: string,
  balanceDollars: string,
  estimatedDaysRemaining?: number,
  creditsUrl?: string,
): TemplateResult {
  const escapedEmail = escapeHtml(email);
  const escapedBalance = escapeHtml(balanceDollars);
  const daysLine =
    estimatedDaysRemaining != null
      ? `<p>At your current usage, your credits will run out in approximately <strong>${estimatedDaysRemaining} day${estimatedDaysRemaining === 1 ? "" : "s"}</strong>.</p>`
      : "";
  const daysTextLine =
    estimatedDaysRemaining != null
      ? `At your current usage, your credits will run out in approximately ${estimatedDaysRemaining} day${estimatedDaysRemaining === 1 ? "" : "s"}.`
      : "";

  const parts = [
    heading("Your WOPR Credits Are Running Low"),
    paragraph(`<p>Hi <strong>${escapedEmail}</strong>,</p>
    <p>Your WOPR credit balance is now <strong>${escapedBalance}</strong>. When your balance reaches $0, your bots will be paused.</p>
    ${daysLine}
    <p>Top up your credits to keep your bots running.</p>`),
  ];
  if (creditsUrl) parts.push(button(creditsUrl, "Buy Credits"));
  parts.push(footer("This is an automated notification based on your account balance."));
  parts.push(unsubscribeFooter(creditsUrl ? buildUnsubscribeUrl(creditsUrl) : undefined));

  const html = wrapHtml("Low Balance", parts.join("\n"));

  const text = `Your WOPR Credits Are Running Low

Hi ${email},

Your WOPR credit balance is now ${balanceDollars}. When your balance reaches $0, your bots will be paused.
${daysTextLine ? `${daysTextLine}\n` : ""}
Top up your credits to keep your bots running.
${creditsUrl ? `\nBuy credits: ${creditsUrl}` : ""}${unsubscribeText(creditsUrl ? buildUnsubscribeUrl(creditsUrl) : undefined)}

(c) ${new Date().getFullYear()} WOPR Network. All rights reserved.`;

  return { subject: "Your WOPR credits are running low", html, text };
}

// ---------------------------------------------------------------------------
// 6. Bot Suspended
// ---------------------------------------------------------------------------

export function botSuspendedTemplate(
  email: string,
  botName: string,
  reason: string,
  creditsUrl?: string,
): TemplateResult {
  const escapedEmail = escapeHtml(email);
  const escapedBotName = escapeHtml(botName);
  const escapedReason = escapeHtml(reason);

  const parts = [
    heading("Your Bot Has Been Suspended"),
    paragraph(`<p>Hi <strong>${escapedEmail}</strong>,</p>
    <p>Your bot <strong>${escapedBotName}</strong> has been suspended.</p>
    <p><strong>Reason:</strong> ${escapedReason}</p>
    <p>Buy credits to reactivate instantly. Your data is preserved for 30 days.</p>`),
  ];
  if (creditsUrl) parts.push(button(creditsUrl, "Buy Credits to Reactivate"));
  parts.push(footer("If you need help, reply to this email or contact support@wopr.bot."));
  parts.push(unsubscribeFooter(creditsUrl ? buildUnsubscribeUrl(creditsUrl) : undefined));

  const html = wrapHtml("Bot Suspended", parts.join("\n"));

  const text = `Your Bot Has Been Suspended

Hi ${email},

Your bot "${botName}" has been suspended.

Reason: ${reason}

Buy credits to reactivate instantly. Your data is preserved for 30 days.
${creditsUrl ? `\nBuy credits: ${creditsUrl}` : ""}
If you need help, reply to this email or contact support@wopr.bot.${unsubscribeText(creditsUrl ? buildUnsubscribeUrl(creditsUrl) : undefined)}

(c) ${new Date().getFullYear()} WOPR Network. All rights reserved.`;

  return { subject: "Your bot has been suspended", html, text };
}

// ---------------------------------------------------------------------------
// 7. Bot Destruction Warning
// ---------------------------------------------------------------------------

export function botDestructionTemplate(
  email: string,
  botName: string,
  daysRemaining: number,
  creditsUrl?: string,
): TemplateResult {
  const escapedEmail = escapeHtml(email);
  const escapedBotName = escapeHtml(botName);
  const days = String(daysRemaining);
  const deadline = new Date(Date.now() + daysRemaining * 24 * 60 * 60 * 1000).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  const parts = [
    heading("URGENT: Bot Data Will Be Deleted"),
    paragraph(`<p>Hi <strong>${escapedEmail}</strong>,</p>
    <p>Your bot <strong>${escapedBotName}</strong> has been suspended and its data will be permanently deleted in <strong>${escapeHtml(days)} days</strong> (by ${escapeHtml(deadline)}).</p>
    <p>Buy credits before the deadline to save your data.</p>`),
  ];
  if (creditsUrl) parts.push(button(creditsUrl, "Buy Credits Now", "#dc2626"));
  parts.push(
    footer("This action is irreversible. All bot configuration, history, and connected services will be removed."),
  );
  parts.push(unsubscribeFooter(creditsUrl ? buildUnsubscribeUrl(creditsUrl) : undefined));

  const html = wrapHtml("Bot Data Deletion", parts.join("\n"));

  const text = `URGENT: Bot Data Will Be Deleted

Hi ${email},

Your bot "${botName}" has been suspended and its data will be permanently deleted in ${daysRemaining} days (by ${deadline}).

Buy credits before the deadline to save your data.
${creditsUrl ? `\nBuy credits now: ${creditsUrl}` : ""}
This action is irreversible. All bot configuration, history, and connected services will be removed.${unsubscribeText(creditsUrl ? buildUnsubscribeUrl(creditsUrl) : undefined)}

(c) ${new Date().getFullYear()} WOPR Network. All rights reserved.`;

  return { subject: `URGENT: Your bot data will be deleted in ${daysRemaining} days`, html, text };
}

// ---------------------------------------------------------------------------
// 8. Data Deleted Confirmation
// ---------------------------------------------------------------------------

export function dataDeletedTemplate(email: string, creditsUrl?: string): TemplateResult {
  const escapedEmail = escapeHtml(email);

  const parts = [
    heading("Your Bot Data Has Been Deleted"),
    paragraph(`<p>Hi <strong>${escapedEmail}</strong>,</p>
    <p>Your suspended bot data has been permanently deleted after 30 days of inactivity.</p>
    <p>You can create a new bot anytime by adding credits to your account.</p>`),
  ];
  if (creditsUrl) parts.push(button(creditsUrl, "Add Credits"));
  parts.push(footer("If you have questions, contact support@wopr.bot."));
  parts.push(unsubscribeFooter(creditsUrl ? buildUnsubscribeUrl(creditsUrl) : undefined));

  const html = wrapHtml("Data Deleted", parts.join("\n"));

  const text = `Your Bot Data Has Been Deleted

Hi ${email},

Your suspended bot data has been permanently deleted after 30 days of inactivity.

You can create a new bot anytime by adding credits to your account.
${creditsUrl ? `\nAdd credits: ${creditsUrl}` : ""}
If you have questions, contact support@wopr.bot.${unsubscribeText(creditsUrl ? buildUnsubscribeUrl(creditsUrl) : undefined)}

(c) ${new Date().getFullYear()} WOPR Network. All rights reserved.`;

  return { subject: "Your bot data has been deleted", html, text };
}

// ---------------------------------------------------------------------------
// Org Invite
// ---------------------------------------------------------------------------

export function orgInviteEmailTemplate(inviteUrl: string, orgName: string): TemplateResult {
  const safeOrg = escapeHtml(orgName);
  const safeUrl = escapeHtml(inviteUrl);

  const html = wrapHtml(
    `You're invited to join ${safeOrg}`,
    [
      heading(`Join ${safeOrg}`),
      paragraph(
        `You've been invited to join <strong>${safeOrg}</strong> on WOPR Network. Click the button below to accept the invitation.`,
      ),
      button(safeUrl, "Accept Invitation"),
      footer("This invitation expires in 7 days. If you didn't expect this email, you can safely ignore it."),
    ].join("\n"),
  );

  const text = `You're invited to join ${orgName} on WOPR Network.

Accept the invitation: ${inviteUrl}

This invitation expires in 7 days.`;

  return { subject: `You're invited to join ${orgName}`, html, text };
}
