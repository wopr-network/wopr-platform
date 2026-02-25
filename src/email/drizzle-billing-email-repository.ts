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
  shouldSend(tenantId: string, emailType: BillingEmailType): boolean;
  /** Records that an email was sent. */
  recordSent(tenantId: string, emailType: BillingEmailType): void;
}

// ---------------------------------------------------------------------------
// Drizzle Implementation
// ---------------------------------------------------------------------------

export class DrizzleBillingEmailRepository implements IBillingEmailRepository {
  constructor(private readonly db: DrizzleDb) {}

  shouldSend(tenantId: string, emailType: BillingEmailType): boolean {
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

  recordSent(tenantId: string, emailType: BillingEmailType): void {
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
}
