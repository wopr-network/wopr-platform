/**
 * Billing Email Service — deduplication + sending for billing-triggered emails.
 *
 * Uses the emailNotifications table to ensure at most one email of each type
 * per tenant per day. All queries use Drizzle — zero raw SQL.
 */

import crypto from "node:crypto";
import { and, eq } from "drizzle-orm";
import { logger } from "../config/logger.js";
import type { DrizzleDb } from "../db/index.js";
import { emailNotifications } from "../db/schema/email-notifications.js";
import type { EmailClient } from "./client.js";
import {
  botDestructionTemplate,
  botSuspendedTemplate,
  creditPurchaseTemplate,
  dataDeletedTemplate,
  lowBalanceTemplate,
} from "./templates.js";

export type BillingEmailType = "credit-purchase" | "low-balance" | "bot-suspended" | "bot-destruction" | "data-deleted";

export interface BillingEmailServiceConfig {
  db: DrizzleDb;
  emailClient: EmailClient;
  /** Base URL for CTA links (e.g. "https://app.wopr.bot"). */
  appBaseUrl: string;
}

export class BillingEmailService {
  private readonly db: DrizzleDb;
  private readonly emailClient: EmailClient;
  private readonly appBaseUrl: string;

  constructor(config: BillingEmailServiceConfig) {
    this.db = config.db;
    this.emailClient = config.emailClient;
    this.appBaseUrl = config.appBaseUrl;
  }

  /**
   * Check if an email of this type was already sent today for this tenant.
   * Uses Drizzle queries only — no raw SQL.
   */
  shouldSendEmail(tenantId: string, emailType: BillingEmailType): boolean {
    const today = new Date().toISOString().split("T")[0];
    const existing = this.db
      .select({ id: emailNotifications.id })
      .from(emailNotifications)
      .where(
        and(
          eq(emailNotifications.tenantId, tenantId),
          eq(emailNotifications.emailType, emailType),
          eq(emailNotifications.sentDate, today),
        ),
      )
      .limit(1)
      .get();

    return existing == null;
  }

  /**
   * Record that an email was sent. Uses Drizzle insert — no raw SQL.
   */
  recordEmailSent(tenantId: string, emailType: BillingEmailType): void {
    const today = new Date().toISOString().split("T")[0];
    this.db
      .insert(emailNotifications)
      .values({
        id: crypto.randomUUID(),
        tenantId,
        emailType,
        sentDate: today,
      })
      .run();
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

      this.recordEmailSent(tenantId, "credit-purchase");
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
    if (!this.shouldSendEmail(tenantId, "low-balance")) {
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

      this.recordEmailSent(tenantId, "low-balance");
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
    if (!this.shouldSendEmail(tenantId, "bot-suspended")) {
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

      this.recordEmailSent(tenantId, "bot-suspended");
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
    if (!this.shouldSendEmail(tenantId, "bot-destruction")) {
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

      this.recordEmailSent(tenantId, "bot-destruction");
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
    if (!this.shouldSendEmail(tenantId, "data-deleted")) {
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

      this.recordEmailSent(tenantId, "data-deleted");
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
