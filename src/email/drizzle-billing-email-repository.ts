/**
 * Billing Email Repository — deduplication record storage for billing emails.
 *
 * Implements IBillingEmailRepository using Drizzle ORM.
 * BillingEmailService depends on this interface, not on DrizzleDb directly.
 */

import crypto from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { DrizzleDb } from "../db/index.js";
import { emailNotifications } from "../db/schema/email-notifications.js";
import type { BillingEmailType } from "./billing-emails.js";

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

/** Repository interface for billing email deduplication records. */
export interface IBillingEmailRepository {
  /** Returns true if no email of this type was sent to this tenant today. */
  shouldSend(tenantId: string, emailType: BillingEmailType): Promise<boolean>;
  /** Records that an email was sent. */
  recordSent(tenantId: string, emailType: BillingEmailType): Promise<void>;
}

// ---------------------------------------------------------------------------
// Drizzle Implementation
// ---------------------------------------------------------------------------

export class DrizzleBillingEmailRepository implements IBillingEmailRepository {
  constructor(private readonly db: DrizzleDb) {}

  async shouldSend(tenantId: string, emailType: BillingEmailType): Promise<boolean> {
    const today = new Date().toISOString().split("T")[0];
    const rows = await this.db
      .select({ id: emailNotifications.id })
      .from(emailNotifications)
      .where(
        and(
          eq(emailNotifications.tenantId, tenantId),
          eq(emailNotifications.emailType, emailType),
          eq(emailNotifications.sentDate, today),
        ),
      )
      .limit(1);

    return rows.length === 0;
  }

  async recordSent(tenantId: string, emailType: BillingEmailType): Promise<void> {
    const today = new Date().toISOString().split("T")[0];
    await this.db.insert(emailNotifications).values({
      id: crypto.randomUUID(),
      tenantId,
      emailType,
      sentDate: today,
    });
  }
}
