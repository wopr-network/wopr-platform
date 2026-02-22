import crypto from "node:crypto";
import type { DrizzleDb } from "../../db/index.js";
import { creditAutoTopup } from "../../db/schema/credit-auto-topup.js";

export interface AutoTopupEventLogEntry {
  tenantId: string;
  amountCents: number;
  status: "success" | "failed";
  failureReason?: string | null;
  paymentReference?: string | null;
}

export interface IAutoTopupEventLogRepository {
  writeEvent(entry: AutoTopupEventLogEntry): void;
}

export class DrizzleAutoTopupEventLogRepository implements IAutoTopupEventLogRepository {
  constructor(private readonly db: DrizzleDb) {}

  writeEvent(entry: AutoTopupEventLogEntry): void {
    this.db
      .insert(creditAutoTopup)
      .values({
        id: crypto.randomUUID(),
        tenantId: entry.tenantId,
        amountCents: entry.amountCents,
        status: entry.status,
        failureReason: entry.failureReason ?? null,
        paymentReference: entry.paymentReference ?? null,
      })
      .run();
  }
}
