import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { DrizzleDb } from "../../db/index.js";
import { tenantApiKeys } from "../../db/schema/tenant-api-keys.js";
import type {
  TenantApiKey,
  TenantApiKeyWithoutKey,
  TenantKeyRepository,
} from "../../domain/repositories/tenant-key-repository.js";
import type { EncryptedPayload } from "../../security/types.js";

export class DrizzleTenantKeyRepository implements TenantKeyRepository {
  constructor(private readonly db: DrizzleDb) {}

  async upsert(tenantId: string, provider: string, encryptedKey: EncryptedPayload, label = ""): Promise<string> {
    const now = Date.now();
    const serialized = JSON.stringify(encryptedKey);

    const existing = await this.db
      .select({ id: tenantApiKeys.id })
      .from(tenantApiKeys)
      .where(and(eq(tenantApiKeys.tenantId, tenantId), eq(tenantApiKeys.provider, provider)))
      .get();

    if (existing) {
      await this.db
        .update(tenantApiKeys)
        .set({ encryptedKey: serialized, label, updatedAt: now })
        .where(eq(tenantApiKeys.id, existing.id))
        .run();
      return existing.id;
    }

    const id = randomUUID();
    await this.db
      .insert(tenantApiKeys)
      .values({
        id,
        tenantId,
        provider,
        label,
        encryptedKey: serialized,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    return id;
  }

  async get(tenantId: string, provider: string): Promise<TenantApiKey | null> {
    const row = await this.db
      .select()
      .from(tenantApiKeys)
      .where(and(eq(tenantApiKeys.tenantId, tenantId), eq(tenantApiKeys.provider, provider)))
      .get();
    return (row as TenantApiKey | null) ?? null;
  }

  async listForTenant(tenantId: string): Promise<TenantApiKeyWithoutKey[]> {
    const rows = await this.db
      .select({
        id: tenantApiKeys.id,
        tenantId: tenantApiKeys.tenantId,
        provider: tenantApiKeys.provider,
        label: tenantApiKeys.label,
        createdAt: tenantApiKeys.createdAt,
        updatedAt: tenantApiKeys.updatedAt,
      })
      .from(tenantApiKeys)
      .where(eq(tenantApiKeys.tenantId, tenantId))
      .all();
    return rows as TenantApiKeyWithoutKey[];
  }

  async delete(tenantId: string, provider: string): Promise<boolean> {
    const result = await this.db
      .delete(tenantApiKeys)
      .where(and(eq(tenantApiKeys.tenantId, tenantId), eq(tenantApiKeys.provider, provider)))
      .run();
    return result.changes > 0;
  }

  async deleteAllForTenant(tenantId: string): Promise<number> {
    const result = await this.db.delete(tenantApiKeys).where(eq(tenantApiKeys.tenantId, tenantId)).run();
    return result.changes;
  }
}
