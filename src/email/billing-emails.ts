/**
 * Billing Email Service — deduplication + sending for billing-triggered emails.
 *
 * Uses the emailNotifications table to ensure at most one email of each type
 * per tenant per day. All queries use Drizzle — zero raw SQL.
 */

import { logger } from "../config/logger.js";
import type { EmailClient } from "./client.js";
import type { IBillingEmailRepository } from "./drizzle-billing-email-repository.js";
import {
  botDestructionTemplate,
  botSuspendedTemplate,
  creditPurchaseTemplate,
  dataDeletedTemplate,
  lowBalanceTemplate,
} from "./templates.js";

export type BillingEmailType = "credit-purchase" | "low-balance" | "bot-suspended" | "bot-destruction" | "data-deleted";

export interface BillingEmailServiceConfig {
  billingEmailRepo: IBillingEmailRepository;
  emailClient: EmailClient;
  /** Base URL for CTA links (e.g. "https://app.wopr.bot"). */
  appBaseUrl: string;
}

export class BillingEmailService {
  private readonly billingEmailRepo: IBillingEmailRepository;
  private readonly emailClient: EmailClient;
  private readonly appBaseUrl: string;

  constructor(config: BillingEmailServiceConfig) {
    this.billingEmailRepo = config.billingEmailRepo;
    this.emailClient = config.emailClient;
    this.appBaseUrl = config.appBaseUrl;
  }

  /**
   * Check if an email of this type was already sent today for this tenant.
   */
  async shouldSendEmail(tenantId: string, emailType: BillingEmailType): Promise<boolean> {
    return this.billingEmailRepo.shouldSend(tenantId, emailType);
  }

  /**
   * Record that an email was sent.
   */
  async recordEmailSent(tenantId: string, emailType: BillingEmailType): Promise<void> {
    await this.billingEmailRepo.recordSent(tenantId, emailType);
  }

  /**
   * Send a purchase receipt email.
   * Always sends (no daily dedup — receipts are per-transaction).
   */
  async sendPurchaseReceipt(
    email: string,
    tenantId: string,
    amountDollars: string,
    newBalanceDollars: string,
  ): Promise<boolean> {
    try {
      const template = creditPurchaseTemplate(email, amountDollars, newBalanceDollars, this.creditsUrl());
      await this.emailClient.send({
        to: email,
        ...template,
        userId: tenantId,
        templateName: "credit-purchase",
      });

      await this.recordEmailSent(tenantId, "credit-purchase");
      return true;
    } catch (err) {
      logger.error("Failed to send purchase receipt", {
        tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /**
   * Send a low balance warning. Deduped: max once per day.
   */
  async sendLowBalanceWarning(
    email: string,
    tenantId: string,
    balanceDollars: string,
    estimatedDaysRemaining: number,
  ): Promise<boolean> {
    if (!(await this.shouldSendEmail(tenantId, "low-balance"))) {
      return false;
    }

    try {
      const template = lowBalanceTemplate(email, balanceDollars, estimatedDaysRemaining, this.creditsUrl());
      await this.emailClient.send({
        to: email,
        ...template,
        userId: tenantId,
        templateName: "low-balance",
      });

      await this.recordEmailSent(tenantId, "low-balance");
      return true;
    } catch (err) {
      logger.error("Failed to send low balance warning", {
        tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /**
   * Send a bot suspended notification. Deduped: max once per day.
   */
  async sendBotSuspendedNotice(email: string, tenantId: string, botNames: string[]): Promise<boolean> {
    if (!(await this.shouldSendEmail(tenantId, "bot-suspended"))) {
      return false;
    }

    try {
      const botsDisplay = botNames.length > 0 ? botNames.join(", ") : "your bot(s)";
      const template = botSuspendedTemplate(email, botsDisplay, "Insufficient credits", this.creditsUrl());
      await this.emailClient.send({
        to: email,
        ...template,
        userId: tenantId,
        templateName: "bot-suspended",
      });

      await this.recordEmailSent(tenantId, "bot-suspended");
      return true;
    } catch (err) {
      logger.error("Failed to send bot suspended notice", {
        tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /**
   * Send a destruction warning (5 days left). Deduped: max once per day.
   */
  async sendDestructionWarning(email: string, tenantId: string, botNames: string[]): Promise<boolean> {
    if (!(await this.shouldSendEmail(tenantId, "bot-destruction"))) {
      return false;
    }

    try {
      const botsDisplay = botNames.length > 0 ? botNames.join(", ") : "your bot(s)";
      const template = botDestructionTemplate(email, botsDisplay, 5, this.creditsUrl());
      await this.emailClient.send({
        to: email,
        ...template,
        userId: tenantId,
        templateName: "bot-destruction",
      });

      await this.recordEmailSent(tenantId, "bot-destruction");
      return true;
    } catch (err) {
      logger.error("Failed to send destruction warning", {
        tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /**
   * Send a data deleted confirmation. Deduped: max once per day.
   */
  async sendDataDeletedNotice(email: string, tenantId: string): Promise<boolean> {
    if (!(await this.shouldSendEmail(tenantId, "data-deleted"))) {
      return false;
    }

    try {
      const template = dataDeletedTemplate(email, this.creditsUrl());
      await this.emailClient.send({
        to: email,
        ...template,
        userId: tenantId,
        templateName: "data-deleted",
      });

      await this.recordEmailSent(tenantId, "data-deleted");
      return true;
    } catch (err) {
      logger.error("Failed to send data deleted notice", {
        tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  private creditsUrl(): string {
    return `${this.appBaseUrl}/credits`;
  }
}
