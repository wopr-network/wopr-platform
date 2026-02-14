/**
 * Email — Transactional email system via Resend.
 *
 * Provides:
 * - EmailClient for sending template-based emails
 * - 8 email templates (verify, welcome, password-reset, credit-purchase, low-balance, bot-suspended, bot-destruction, data-deleted)
 * - BillingEmailService for deduplication + billing notifications (WOP-450)
 * - Email verification flow (token generation, validation)
 * - requireEmailVerified middleware for gating actions
 */

export type { BillingEmailServiceConfig, BillingEmailType } from "./billing-emails.js";
export { BillingEmailService } from "./billing-emails.js";
export type { EmailClientConfig, EmailSendResult, SendTemplateEmailOpts } from "./client.js";
export { EmailClient, getEmailClient, resetEmailClient, setEmailClient } from "./client.js";
export { requireEmailVerified } from "./require-verified.js";
export type { EmailOptions } from "./resend-adapter.js";
export { escapeHtml, sendEmail } from "./resend-adapter.js";
export type { TemplateName, TemplateResult } from "./templates.js";
export {
  botDestructionTemplate,
  botSuspendedTemplate,
  creditPurchaseTemplate,
  dataDeletedTemplate,
  lowBalanceTemplate,
  passwordResetEmailTemplate,
  verifyEmailTemplate,
  welcomeTemplate,
} from "./templates.js";
export type { VerificationToken } from "./verification.js";
export {
  generateVerificationToken,
  getUserEmail,
  initVerificationSchema,
  isEmailVerified,
  verifyToken,
} from "./verification.js";
