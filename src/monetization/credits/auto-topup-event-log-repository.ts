import crypto from "node:crypto";
import type { DrizzleDb } from "../../db/index.js";
import { creditAutoTopup } from "../../db/schema/credit-auto-topup.js";

export interface AutoTopupEventLogEntry {
  tenantId: string;
  amountCredits: number;
  status: "success" | "failed";
  failureReason?: string | null;
  paymentReference?: string | null;
}

export interface IAutoTopupEventLogRepository {
  writeEvent(entry: AutoTopupEventLogEntry): Promise<void>;
}

export class DrizzleAutoTopupEventLogRepository implements IAutoTopupEventLogRepository {
  constructor(private readonly db: DrizzleDb) {}

  async writeEvent(entry: AutoTopupEventLogEntry): Promise<void> {
    await this.db.insert(creditAutoTopup).values({
      id: crypto.randomUUID(),
      tenantId: entry.tenantId,
      amountCredits: entry.amountCredits,
      status: entry.status,
      failureReason: entry.failureReason ?? null,
      paymentReference: entry.paymentReference ?? null,
    });
  }
}
