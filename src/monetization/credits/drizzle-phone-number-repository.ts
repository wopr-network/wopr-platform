import { eq, sql } from "drizzle-orm";
import type { DrizzleDb } from "../../db/index.js";
import { provisionedPhoneNumbers } from "../../db/schema/provisioned-phone-numbers.js";
import type { ProvisionedPhoneNumber } from "./repository-types.js";

export interface IPhoneNumberRepository {
  trackPhoneNumber(tenantId: string, sid: string, phoneNumber: string): Promise<void>;
  removePhoneNumber(sid: string): Promise<void>;
  listActivePhoneNumbers(): Promise<ProvisionedPhoneNumber[]>;
  listByTenant(tenantId: string): Promise<ProvisionedPhoneNumber[]>;
  markBilled(sid: string): Promise<void>;
}

export class DrizzlePhoneNumberRepository implements IPhoneNumberRepository {
  constructor(private readonly db: DrizzleDb) {}

  async trackPhoneNumber(tenantId: string, sid: string, phoneNumber: string): Promise<void> {
    await this.db
      .insert(provisionedPhoneNumbers)
      .values({
        sid,
        tenantId,
        phoneNumber,
        provisionedAt: new Date().toISOString(),
        lastBilledAt: null,
      })
      .onConflictDoNothing();
  }

  async removePhoneNumber(sid: string): Promise<void> {
    await this.db.delete(provisionedPhoneNumbers).where(eq(provisionedPhoneNumbers.sid, sid));
  }

  async listActivePhoneNumbers(): Promise<ProvisionedPhoneNumber[]> {
    const rows = await this.db.select().from(provisionedPhoneNumbers);
    return rows.map(toPhone);
  }

  async listByTenant(tenantId: string): Promise<ProvisionedPhoneNumber[]> {
    const rows = await this.db
      .select()
      .from(provisionedPhoneNumbers)
      .where(eq(provisionedPhoneNumbers.tenantId, tenantId));
    return rows.map(toPhone);
  }

  async markBilled(sid: string): Promise<void> {
    await this.db
      .update(provisionedPhoneNumbers)
      .set({ lastBilledAt: sql`now()` })
      .where(eq(provisionedPhoneNumbers.sid, sid));
  }
}

function toPhone(row: typeof provisionedPhoneNumbers.$inferSelect): ProvisionedPhoneNumber {
  return {
    sid: row.sid,
    tenantId: row.tenantId,
    phoneNumber: row.phoneNumber,
    provisionedAt: row.provisionedAt,
    lastBilledAt: row.lastBilledAt ?? null,
  };
}
