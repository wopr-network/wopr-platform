/**
 * Notification Templates — renders all system notification emails.
 *
 * Separate from templates.ts (which handles billing/auth emails) to keep
 * each file focused. Imports shared layout helpers from templates.ts.
 *
 * Export: renderNotificationTemplate(template, data) → TemplateResult
 */

import { escapeHtml } from "./resend-adapter.js";
import type { TemplateResult } from "./templates.js";

// ---------------------------------------------------------------------------
// Re-export TemplateName extended with notification templates
// ---------------------------------------------------------------------------

export type NotificationTemplateName =
  | "credits-depleted"
  | "grace-period-start"
  | "grace-period-warning"
  | "auto-suspended"
  | "auto-topup-success"
  | "auto-topup-failed"
  | "crypto-payment-confirmed"
  | "admin-suspended"
  | "admin-reactivated"
  | "credits-granted"
  | "role-changed"
  | "team-invite"
  | "agent-created"
  | "channel-connected"
  | "channel-disconnected"
  | "agent-suspended"
  | "custom"
  // Passthrough to existing templates
  | "low-balance"
  | "credit-purchase-receipt"
  | "welcome"
  | "password-reset";

export type TemplateName = NotificationTemplateName;

// ---------------------------------------------------------------------------
// Shared layout helpers (duplicated locally so this file is self-contained)
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

function copyright(): string {
  return `\n\n(c) ${new Date().getFullYear()} WOPR Network. All rights reserved.`;
}

// ---------------------------------------------------------------------------
// Individual template renderers
// ---------------------------------------------------------------------------

function creditsDepletedTemplate(data: Record<string, unknown>): TemplateResult {
  const creditsUrl = (data.creditsUrl as string) || "";
  const parts = [
    heading("Your WOPR Credits Are Depleted"),
    paragraph(
      "<p>Your WOPR credit balance has reached $0. All agent capabilities have been paused.</p>" +
        "<p>Add credits now to resume service immediately.</p>",
    ),
  ];
  if (creditsUrl) parts.push(button(creditsUrl, "Add Credits"));
  parts.push(footer("Your data is preserved. Add credits to reactivate."));

  return {
    subject: "Your WOPR credits are depleted — capabilities paused",
    html: wrapHtml("Credits Depleted", parts.join("\n")),
    text: `Your WOPR Credits Are Depleted\n\nYour WOPR credit balance has reached $0. All agent capabilities have been paused.\n\nAdd credits now to resume service immediately.\n${creditsUrl ? `\nAdd credits: ${creditsUrl}\n` : ""}${copyright()}`,
  };
}

function gracePeriodStartTemplate(data: Record<string, unknown>): TemplateResult {
  const balanceDollars = escapeHtml((data.balanceDollars as string) || "$0.00");
  const graceDays = Number(data.graceDays) || 7;
  const creditsUrl = (data.creditsUrl as string) || "";
  const parts = [
    heading("Action Needed: Top Up to Keep Your WOPRs Running"),
    paragraph(
      `<p>Your current balance is <strong>${balanceDollars}</strong> and the monthly deduction could not be processed.</p>` +
        `<p>You have a <strong>${graceDays}-day grace period</strong> to add credits before your account is suspended.</p>`,
    ),
  ];
  if (creditsUrl) parts.push(button(creditsUrl, "Add Credits Now"));
  parts.push(footer("This is a critical notification about your account status."));

  return {
    subject: "Action needed: top up to keep your WOPRs running",
    html: wrapHtml("Grace Period Started", parts.join("\n")),
    text: `Action Needed: Top Up to Keep Your WOPRs Running\n\nYour current balance is ${data.balanceDollars} and the monthly deduction could not be processed.\n\nYou have a ${graceDays}-day grace period to add credits before your account is suspended.\n${creditsUrl ? `\nAdd credits: ${creditsUrl}\n` : ""}${copyright()}`,
  };
}

function gracePeriodWarningTemplate(data: Record<string, unknown>): TemplateResult {
  const creditsUrl = (data.creditsUrl as string) || "";
  const parts = [
    heading("Last Chance: Your WOPRs Will Be Suspended Tomorrow"),
    paragraph(
      "<p>Your grace period expires tomorrow. If you do not add credits, your account will be suspended.</p>" +
        "<p>Add credits now to keep your agents running.</p>",
    ),
  ];
  if (creditsUrl) parts.push(button(creditsUrl, "Add Credits Now", "#dc2626"));
  parts.push(footer("This is a critical notification about your account status."));

  return {
    subject: "Last chance: your WOPRs will be suspended tomorrow",
    html: wrapHtml("Grace Period Warning", parts.join("\n")),
    text: `Last Chance: Your WOPRs Will Be Suspended Tomorrow\n\nYour grace period expires tomorrow. If you do not add credits, your account will be suspended.\n${creditsUrl ? `\nAdd credits: ${creditsUrl}\n` : ""}${copyright()}`,
  };
}

function autoSuspendedTemplate(data: Record<string, unknown>): TemplateResult {
  const reason = escapeHtml((data.reason as string) || "Grace period expired");
  const creditsUrl = (data.creditsUrl as string) || "";
  const parts = [
    heading("Your Account Has Been Suspended"),
    paragraph(
      `<p>Your WOPR account has been automatically suspended.</p>` +
        `<p><strong>Reason:</strong> ${reason}</p>` +
        `<p>Add credits to reactivate your account immediately.</p>`,
    ),
  ];
  if (creditsUrl) parts.push(button(creditsUrl, "Add Credits to Reactivate"));
  parts.push(footer("Your data is preserved for 30 days."));

  return {
    subject: "Your account has been suspended",
    html: wrapHtml("Account Suspended", parts.join("\n")),
    text: `Your Account Has Been Suspended\n\nReason: ${data.reason}\n\nAdd credits to reactivate your account immediately.\n${creditsUrl ? `\nAdd credits: ${creditsUrl}\n` : ""}${copyright()}`,
  };
}

function autoTopupSuccessTemplate(data: Record<string, unknown>): TemplateResult {
  const amountDollars = escapeHtml((data.amountDollars as string) || "$0.00");
  const newBalanceDollars = escapeHtml((data.newBalanceDollars as string) || "$0.00");
  const creditsUrl = (data.creditsUrl as string) || "";
  const parts = [
    heading(`Auto Top-Up: ${amountDollars} Credits Added`),
    paragraph(
      `<p>Your auto top-up was successful. <strong>${amountDollars}</strong> in credits has been added.</p>` +
        `<p>Your new balance is <strong>${newBalanceDollars}</strong>.</p>`,
    ),
  ];
  if (creditsUrl) parts.push(button(creditsUrl, "View Credits"));
  parts.push(footer("Auto top-up keeps your agents running without interruption."));

  return {
    subject: `Auto top-up: ${data.amountDollars} credits added`,
    html: wrapHtml("Auto Top-Up Successful", parts.join("\n")),
    text: `Auto Top-Up: ${data.amountDollars} Credits Added\n\nYour auto top-up was successful. ${data.amountDollars} in credits has been added.\n\nYour new balance is ${data.newBalanceDollars}.\n${creditsUrl ? `\nView credits: ${creditsUrl}\n` : ""}${copyright()}`,
  };
}

function autoTopupFailedTemplate(data: Record<string, unknown>): TemplateResult {
  const creditsUrl = (data.creditsUrl as string) || "";
  const parts = [
    heading("Auto Top-Up Failed"),
    paragraph(
      "<p>Your auto top-up failed. We were unable to charge your payment method.</p>" +
        "<p>Please update your payment method or add credits manually to avoid service interruption.</p>",
    ),
  ];
  if (creditsUrl) parts.push(button(creditsUrl, "Add Credits"));
  parts.push(footer("If you need help, contact support@wopr.bot."));

  return {
    subject: "Auto top-up failed — update your payment method",
    html: wrapHtml("Auto Top-Up Failed", parts.join("\n")),
    text: `Auto Top-Up Failed\n\nYour auto top-up failed. We were unable to charge your payment method.\n\nPlease update your payment method or add credits manually to avoid service interruption.\n${creditsUrl ? `\nAdd credits: ${creditsUrl}\n` : ""}${copyright()}`,
  };
}

function cryptoPaymentConfirmedTemplate(data: Record<string, unknown>): TemplateResult {
  const amountDollars = escapeHtml((data.amountDollars as string) || "$0.00");
  const newBalanceDollars = escapeHtml((data.newBalanceDollars as string) || "$0.00");
  const parts = [
    heading(`Crypto Payment Confirmed: ${amountDollars} Credits Added`),
    paragraph(
      `<p>Your crypto payment has been confirmed. <strong>${amountDollars}</strong> in credits has been added to your account.</p>` +
        `<p>Your new balance is <strong>${newBalanceDollars}</strong>.</p>`,
    ),
  ];
  parts.push(footer("Thank you for supporting WOPR!"));

  return {
    subject: `Crypto payment confirmed: ${data.amountDollars} credits added`,
    html: wrapHtml("Crypto Payment Confirmed", parts.join("\n")),
    text: `Crypto Payment Confirmed: ${data.amountDollars} Credits Added\n\nYour crypto payment has been confirmed. ${data.amountDollars} in credits has been added.\n\nYour new balance is ${data.newBalanceDollars}.\n${copyright()}`,
  };
}

function adminSuspendedTemplate(data: Record<string, unknown>): TemplateResult {
  const reason = escapeHtml((data.reason as string) || "Policy violation");
  const parts = [
    heading("Your Account Has Been Suspended"),
    paragraph(
      `<p>Your WOPR account has been suspended by an administrator.</p>` +
        `<p><strong>Reason:</strong> ${reason}</p>` +
        `<p>If you believe this is an error, please contact support@wopr.bot.</p>`,
    ),
  ];
  parts.push(footer("Contact support@wopr.bot if you have questions."));

  return {
    subject: "Your account has been suspended",
    html: wrapHtml("Account Suspended", parts.join("\n")),
    text: `Your Account Has Been Suspended\n\nReason: ${data.reason}\n\nIf you believe this is an error, please contact support@wopr.bot.\n${copyright()}`,
  };
}

function adminReactivatedTemplate(_data: Record<string, unknown>): TemplateResult {
  const parts = [
    heading("Your Account Has Been Reactivated"),
    paragraph(
      "<p>Your WOPR account has been reactivated. You now have full access to all services.</p>" +
        "<p>Your agents and channels are ready to use.</p>",
    ),
  ];
  parts.push(footer("Welcome back!"));

  return {
    subject: "Your account has been reactivated",
    html: wrapHtml("Account Reactivated", parts.join("\n")),
    text: `Your Account Has Been Reactivated\n\nYour WOPR account has been reactivated. You now have full access to all services.\n${copyright()}`,
  };
}

function creditsGrantedTemplate(data: Record<string, unknown>): TemplateResult {
  const amountDollars = escapeHtml((data.amountDollars as string) || "$0.00");
  const reason = escapeHtml((data.reason as string) || "");
  const parts = [
    heading(`You Received ${amountDollars} in Credits`),
    paragraph(
      `<p><strong>${amountDollars}</strong> in credits has been added to your WOPR account.</p>` +
        (reason ? `<p><strong>Note:</strong> ${reason}</p>` : ""),
    ),
  ];
  parts.push(footer("Thank you for using WOPR!"));

  return {
    subject: `You received ${data.amountDollars} in credits`,
    html: wrapHtml("Credits Granted", parts.join("\n")),
    text: `You Received ${data.amountDollars} in Credits\n\n${data.amountDollars} has been added to your account.${reason ? `\n\nNote: ${data.reason}` : ""}\n${copyright()}`,
  };
}

function roleChangedTemplate(data: Record<string, unknown>): TemplateResult {
  const newRole = escapeHtml((data.newRole as string) || "");
  const parts = [
    heading("Your Role Has Been Updated"),
    paragraph(
      `<p>Your role on the WOPR platform has been updated to <strong>${newRole}</strong>.</p>` +
        "<p>Your new permissions are now active.</p>",
    ),
  ];
  parts.push(footer("If you did not expect this change, contact support@wopr.bot."));

  return {
    subject: "Your role has been updated",
    html: wrapHtml("Role Changed", parts.join("\n")),
    text: `Your Role Has Been Updated\n\nYour role has been updated to ${data.newRole}.\n${copyright()}`,
  };
}

function teamInviteTemplate(data: Record<string, unknown>): TemplateResult {
  const tenantName = escapeHtml((data.tenantName as string) || "a tenant");
  const inviteUrl = (data.inviteUrl as string) || "";
  const parts = [
    heading(`You've Been Invited to Join ${tenantName}`),
    paragraph(
      `<p>You've been invited to join <strong>${tenantName}</strong> on the WOPR platform.</p>` +
        "<p>Click below to accept the invitation.</p>",
    ),
  ];
  if (inviteUrl) parts.push(button(inviteUrl, "Accept Invitation"));
  parts.push(footer("If you did not expect this invitation, you can ignore this email."));

  return {
    subject: `You've been invited to join ${data.tenantName}`,
    html: wrapHtml("Team Invite", parts.join("\n")),
    text: `You've Been Invited to Join ${data.tenantName}\n\n${inviteUrl ? `Accept: ${inviteUrl}\n` : ""}${copyright()}`,
  };
}

function agentCreatedTemplate(data: Record<string, unknown>): TemplateResult {
  const agentName = escapeHtml((data.agentName as string) || "your agent");
  const parts = [
    heading(`Your WOPR ${agentName} Is Ready`),
    paragraph(
      `<p>Your new agent <strong>${agentName}</strong> has been created and is ready to use.</p>` +
        "<p>Connect it to a channel to start receiving and sending messages.</p>",
    ),
  ];
  parts.push(footer("Happy building!"));

  return {
    subject: `Your WOPR ${data.agentName} is ready`,
    html: wrapHtml("Agent Created", parts.join("\n")),
    text: `Your WOPR ${data.agentName} Is Ready\n\nYour new agent has been created and is ready to use.\n${copyright()}`,
  };
}

function channelConnectedTemplate(data: Record<string, unknown>): TemplateResult {
  const channelName = escapeHtml((data.channelName as string) || "A channel");
  const agentName = escapeHtml((data.agentName as string) || "your agent");
  const parts = [
    heading(`${channelName} Connected to ${agentName}`),
    paragraph(
      `<p><strong>${channelName}</strong> has been successfully connected to <strong>${agentName}</strong>.</p>` +
        "<p>Your agent is now active on this channel.</p>",
    ),
  ];
  parts.push(footer("Your agent is live!"));

  return {
    subject: `${data.channelName} connected to ${data.agentName}`,
    html: wrapHtml("Channel Connected", parts.join("\n")),
    text: `${data.channelName} Connected to ${data.agentName}\n\n${data.channelName} has been successfully connected to ${data.agentName}.\n${copyright()}`,
  };
}

function channelDisconnectedTemplate(data: Record<string, unknown>): TemplateResult {
  const channelName = escapeHtml((data.channelName as string) || "A channel");
  const agentName = escapeHtml((data.agentName as string) || "your agent");
  const reason = escapeHtml((data.reason as string) || "");
  const parts = [
    heading(`${channelName} Disconnected from ${agentName}`),
    paragraph(
      `<p><strong>${channelName}</strong> has been disconnected from <strong>${agentName}</strong>.</p>` +
        (reason ? `<p><strong>Reason:</strong> ${reason}</p>` : "") +
        "<p>Reconnect the channel from your dashboard to restore service.</p>",
    ),
  ];
  parts.push(footer("Your agent data is preserved."));

  return {
    subject: `${data.channelName} disconnected from ${data.agentName}`,
    html: wrapHtml("Channel Disconnected", parts.join("\n")),
    text: `${data.channelName} Disconnected from ${data.agentName}\n\n${reason ? `Reason: ${data.reason}\n\n` : ""}Reconnect from your dashboard to restore service.\n${copyright()}`,
  };
}

function agentSuspendedTemplate(data: Record<string, unknown>): TemplateResult {
  const agentName = escapeHtml((data.agentName as string) || "Your agent");
  const reason = escapeHtml((data.reason as string) || "");
  const parts = [
    heading(`${agentName} Has Been Paused`),
    paragraph(
      `<p>Your agent <strong>${agentName}</strong> has been paused.</p>` +
        (reason ? `<p><strong>Reason:</strong> ${reason}</p>` : ""),
    ),
  ];
  parts.push(footer("Contact support@wopr.bot if you have questions."));

  return {
    subject: `${data.agentName} has been paused`,
    html: wrapHtml("Agent Paused", parts.join("\n")),
    text: `${data.agentName} Has Been Paused\n\n${reason ? `Reason: ${data.reason}\n` : ""}${copyright()}`,
  };
}

function customTemplate(data: Record<string, unknown>): TemplateResult {
  const subject = (data.subject as string) || "Message from WOPR";
  const rawBody = (data.bodyText as string) || "";
  const escapedBody = escapeHtml(rawBody).replace(/\n/g, "<br>\n");

  const parts = [heading("Message from WOPR"), paragraph(`<p>${escapedBody}</p>`)];
  parts.push(footer("This is an administrative message from WOPR Network."));

  return {
    subject,
    html: wrapHtml(escapeHtml(subject), parts.join("\n")),
    text: `${rawBody}\n${copyright()}`,
  };
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/**
 * Render a notification template by name.
 *
 * All new templates are dispatched here. Legacy templates (verify-email,
 * welcome, password-reset, etc.) are handled by templates.ts directly.
 */
export function renderNotificationTemplate(template: TemplateName, data: Record<string, unknown>): TemplateResult {
  switch (template) {
    case "credits-depleted":
      return creditsDepletedTemplate(data);
    case "grace-period-start":
      return gracePeriodStartTemplate(data);
    case "grace-period-warning":
      return gracePeriodWarningTemplate(data);
    case "auto-suspended":
      return autoSuspendedTemplate(data);
    case "auto-topup-success":
      return autoTopupSuccessTemplate(data);
    case "auto-topup-failed":
      return autoTopupFailedTemplate(data);
    case "crypto-payment-confirmed":
      return cryptoPaymentConfirmedTemplate(data);
    case "admin-suspended":
      return adminSuspendedTemplate(data);
    case "admin-reactivated":
      return adminReactivatedTemplate(data);
    case "credits-granted":
      return creditsGrantedTemplate(data);
    case "role-changed":
      return roleChangedTemplate(data);
    case "team-invite":
      return teamInviteTemplate(data);
    case "agent-created":
      return agentCreatedTemplate(data);
    case "channel-connected":
      return channelConnectedTemplate(data);
    case "channel-disconnected":
      return channelDisconnectedTemplate(data);
    case "agent-suspended":
      return agentSuspendedTemplate(data);
    case "custom":
      return customTemplate(data);
    case "low-balance":
      return {
        subject: "Your WOPR credits are running low",
        html: wrapHtml(
          "Low Balance",
          [
            heading("Your WOPR Credits Are Running Low"),
            paragraph(
              `<p>Your balance is <strong>${escapeHtml((data.balanceDollars as string) || "$0.00")}</strong>. Top up to keep your agents running.</p>`,
            ),
            ...(data.creditsUrl ? [button(data.creditsUrl as string, "Buy Credits")] : []),
            footer("This is an automated billing notification."),
          ].join("\n"),
        ),
        text: `Your WOPR Credits Are Running Low\n\nBalance: ${data.balanceDollars}\n${data.creditsUrl ? `\nBuy credits: ${data.creditsUrl}\n` : ""}${copyright()}`,
      };
    case "credit-purchase-receipt":
      return {
        subject: "Credits added to your account",
        html: wrapHtml(
          "Credits Added",
          [
            heading("Credits Added to Your Account"),
            paragraph(
              `<p><strong>${escapeHtml((data.amountDollars as string) || "$0.00")}</strong> in credits has been added.</p>` +
                (data.newBalanceDollars
                  ? `<p>New balance: <strong>${escapeHtml(data.newBalanceDollars as string)}</strong></p>`
                  : ""),
            ),
            footer("Thank you for supporting WOPR!"),
          ].join("\n"),
        ),
        text: `Credits Added\n\n${data.amountDollars} added.\n${copyright()}`,
      };
    case "welcome":
      return {
        subject: "Welcome to WOPR",
        html: wrapHtml(
          "Welcome",
          [
            heading("Welcome to WOPR!"),
            paragraph("<p>Your account is now active. Start building!</p>"),
            footer("Happy building!"),
          ].join("\n"),
        ),
        text: `Welcome to WOPR!\n\nYour account is now active.\n${copyright()}`,
      };
    case "password-reset":
      return {
        subject: "Reset your WOPR password",
        html: wrapHtml(
          "Reset Password",
          [
            heading("Reset Your Password"),
            paragraph("<p>Click below to reset your password.</p>"),
            ...(data.resetUrl ? [button(data.resetUrl as string, "Reset Password")] : []),
            footer("If you did not request this, ignore this email."),
          ].join("\n"),
        ),
        text: `Reset Your Password\n\n${data.resetUrl ? `${data.resetUrl}\n` : ""}${copyright()}`,
      };
    default: {
      // Exhaustiveness check
      const _exhaustive: never = template;
      throw new Error(`Unknown notification template: ${String(_exhaustive)}`);
    }
  }
}
