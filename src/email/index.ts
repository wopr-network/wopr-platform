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

export type {
  IBillingEmailRepository,
  INotificationPreferencesRepository,
  INotificationQueueRepository,
  NotificationPrefs,
  NotificationStatus,
  NotificationTemplateName,
  QueuedNotification,
  TemplateName,
  TemplateResult,
  VerificationToken,
} from "@wopr-network/platform-core/email";
export {
  botDestructionTemplate,
  botSuspendedTemplate,
  creditPurchaseTemplate,
  DrizzleBillingEmailRepository,
  DrizzleNotificationPreferencesStore,
  DrizzleNotificationQueueStore,
  dataDeletedTemplate,
  generateVerificationToken,
  getUserEmail,
  initVerificationSchema,
  isEmailVerified,
  lowBalanceTemplate,
  NotificationService,
  passwordResetEmailTemplate,
  renderNotificationTemplate,
  requireEmailVerified,
  verifyEmailTemplate,
  verifyToken,
  welcomeTemplate,
} from "@wopr-network/platform-core/email";
export type { BillingEmailServiceConfig, BillingEmailType } from "./billing-emails.js";
export { BillingEmailService } from "./billing-emails.js";
export type { EmailClientConfig, EmailSendResult, SendTemplateEmailOpts } from "./client.js";
export { EmailClient, getEmailClient, resetEmailClient, setEmailClient } from "./client.js";
export { NotificationWorker } from "./notification-worker.js";
export type { EmailOptions } from "./resend-adapter.js";
export { escapeHtml, sendEmail } from "./resend-adapter.js";
