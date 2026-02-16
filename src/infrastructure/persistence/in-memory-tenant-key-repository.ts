import { randomUUID } from "node:crypto";
import type {
  TenantApiKey,
  TenantApiKeyWithoutKey,
  TenantKeyRepository,
} from "../../domain/repositories/tenant-key-repository.js";
import type { EncryptedPayload } from "../../security/types.js";

export class InMemoryTenantKeyRepository implements TenantKeyRepository {
  private readonly keys = new Map<string, TenantApiKey>();

  private makeKey(tenantId: string, provider: string): string {
    return `${tenantId}:${provider}`;
  }

  async upsert(tenantId: string, provider: string, encryptedKey: EncryptedPayload, label = ""): Promise<string> {
    const key = this.makeKey(tenantId, provider);
    const now = Date.now();
    const serialized = JSON.stringify(encryptedKey);

    const existing = this.keys.get(key);
    if (existing) {
      existing.encryptedKey = serialized;
      existing.label = label;
      existing.updatedAt = now;
      return existing.id;
    }

    const id = randomUUID();
    const record: TenantApiKey = {
      id,
      tenantId,
      provider,
      label,
      encryptedKey: serialized,
      createdAt: now,
      updatedAt: now,
    };
    this.keys.set(key, record);
    return id;
  }

  async get(tenantId: string, provider: string): Promise<TenantApiKey | null> {
    const key = this.makeKey(tenantId, provider);
    return this.keys.get(key) ?? null;
  }

  async listForTenant(tenantId: string): Promise<TenantApiKeyWithoutKey[]> {
    const results: TenantApiKeyWithoutKey[] = [];
    for (const record of this.keys.values()) {
      if (record.tenantId === tenantId) {
        results.push({
          id: record.id,
          tenantId: record.tenantId,
          provider: record.provider,
          label: record.label,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        });
      }
    }
    return results;
  }

  async delete(tenantId: string, provider: string): Promise<boolean> {
    const key = this.makeKey(tenantId, provider);
    return this.keys.delete(key);
  }

  async deleteAllForTenant(tenantId: string): Promise<number> {
    let count = 0;
    for (const [key, record] of this.keys) {
      if (record.tenantId === tenantId) {
        this.keys.delete(key);
        count++;
      }
    }
    return count;
  }
}
