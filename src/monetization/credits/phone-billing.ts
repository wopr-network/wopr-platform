import { logger } from "../../config/logger.js";

const PHONE_NUMBER_MONTHLY_COST = 1.15;

export interface ProvisionedPhoneNumber {
  sid: string;
  tenantId: string;
  phoneNumber: string;
  provisionedAt: string;
  lastBilledAt: string | null;
}

const phoneNumberStore = new Map<string, ProvisionedPhoneNumber>();

export interface IPhoneNumberRepository {
  trackPhoneNumber(tenantId: string, sid: string, phoneNumber: string): Promise<void>;
  removePhoneNumber(sid: string): Promise<void>;
  listActivePhoneNumbers(): Promise<ProvisionedPhoneNumber[]>;
  listByTenant(tenantId: string): Promise<ProvisionedPhoneNumber[]>;
  markBilled(sid: string): Promise<void>;
}

export class InMemoryPhoneNumberRepository implements IPhoneNumberRepository {
  async trackPhoneNumber(tenantId: string, sid: string, phoneNumber: string): Promise<void> {
    phoneNumberStore.set(sid, {
      sid,
      tenantId,
      phoneNumber,
      provisionedAt: new Date().toISOString(),
      lastBilledAt: null,
    });
  }

  async removePhoneNumber(sid: string): Promise<void> {
    phoneNumberStore.delete(sid);
  }

  async listActivePhoneNumbers(): Promise<ProvisionedPhoneNumber[]> {
    return Array.from(phoneNumberStore.values());
  }

  async listByTenant(tenantId: string): Promise<ProvisionedPhoneNumber[]> {
    return Array.from(phoneNumberStore.values()).filter((p) => p.tenantId === tenantId);
  }

  async markBilled(sid: string): Promise<void> {
    const phone = phoneNumberStore.get(sid);
    if (phone) {
      phone.lastBilledAt = new Date().toISOString();
    }
  }
}

export function getPhoneNumberRepo(): IPhoneNumberRepository {
  return new InMemoryPhoneNumberRepository();
}

export async function runMonthlyPhoneBilling(): Promise<{
  processed: number;
  billed: { tenantId: string; phoneNumber: string; cost: number }[];
  failed: { tenantId: string; error: string }[];
}> {
  const result = {
    processed: 0,
    billed: [] as { tenantId: string; phoneNumber: string; cost: number }[],
    failed: [] as { tenantId: string; error: string }[],
  };

  const phoneRepo = getPhoneNumberRepo();
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const activeNumbers = await phoneRepo.listActivePhoneNumbers();

  for (const number of activeNumbers) {
    result.processed++;

    const lastBilled = number.lastBilledAt ?? number.provisionedAt;
    if (lastBilled > thirtyDaysAgo.toISOString()) {
      continue;
    }

    try {
      logger.info("Monthly phone billing", {
        tenantId: number.tenantId,
        phoneNumber: number.phoneNumber,
        cost: PHONE_NUMBER_MONTHLY_COST,
      });

      await phoneRepo.markBilled(number.sid);

      result.billed.push({
        tenantId: number.tenantId,
        phoneNumber: number.phoneNumber,
        cost: PHONE_NUMBER_MONTHLY_COST,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.failed.push({ tenantId: number.tenantId, error: msg });
      logger.error("Monthly phone billing failed", {
        tenantId: number.tenantId,
        phoneNumber: number.phoneNumber,
        error: msg,
      });
    }
  }

  return result;
}
