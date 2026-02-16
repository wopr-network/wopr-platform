import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { AdminAuditLog } from "../../admin/audit-log.js";
import type { DrizzleDb } from "../../db/index.js";
import { providerCredentials } from "../../db/schema/index.js";
import type {
  CreateCredentialInput,
  CredentialSummary,
  CredentialVaultRepository,
  DecryptedCredential,
  RotateCredentialInput,
} from "../../domain/repositories/credential-vault-repository.js";
import { decrypt, encrypt } from "../../security/encryption.js";
import type { EncryptedPayload } from "../../security/types.js";

export class DrizzleCredentialVaultRepository implements CredentialVaultRepository {
  constructor(
    private readonly db: DrizzleDb,
    private readonly encryptionKey: Buffer,
    private readonly auditLog?: AdminAuditLog,
  ) {}

  async create(input: CreateCredentialInput): Promise<string> {
    const id = randomUUID();
    const encrypted = encrypt(input.plaintextKey, this.encryptionKey);
    const serialized = JSON.stringify(encrypted);

    this.db
      .insert(providerCredentials)
      .values({
        id,
        provider: input.provider,
        keyName: input.keyName,
        encryptedValue: serialized,
        authType: input.authType,
        authHeader: input.authHeader ?? null,
        isActive: 1,
        createdBy: input.createdBy,
      })
      .run();

    this.audit(input.createdBy, "credential.create", {
      credentialId: id,
      provider: input.provider,
      keyName: input.keyName,
    });

    return id;
  }

  async list(provider?: string): Promise<CredentialSummary[]> {
    const where = provider ? eq(providerCredentials.provider, provider) : undefined;

    const rows = this.db
      .select({
        id: providerCredentials.id,
        provider: providerCredentials.provider,
        keyName: providerCredentials.keyName,
        authType: providerCredentials.authType,
        authHeader: providerCredentials.authHeader,
        isActive: providerCredentials.isActive,
        lastValidated: providerCredentials.lastValidated,
        createdAt: providerCredentials.createdAt,
        rotatedAt: providerCredentials.rotatedAt,
        createdBy: providerCredentials.createdBy,
      })
      .from(providerCredentials)
      .where(where)
      .orderBy(desc(providerCredentials.createdAt))
      .all();

    return rows.map((r) => ({
      ...r,
      isActive: r.isActive === 1,
    }));
  }

  async getById(id: string): Promise<CredentialSummary | null> {
    const row = this.db
      .select({
        id: providerCredentials.id,
        provider: providerCredentials.provider,
        keyName: providerCredentials.keyName,
        authType: providerCredentials.authType,
        authHeader: providerCredentials.authHeader,
        isActive: providerCredentials.isActive,
        lastValidated: providerCredentials.lastValidated,
        createdAt: providerCredentials.createdAt,
        rotatedAt: providerCredentials.rotatedAt,
        createdBy: providerCredentials.createdBy,
      })
      .from(providerCredentials)
      .where(eq(providerCredentials.id, id))
      .get();

    if (!row) return null;

    return { ...row, isActive: row.isActive === 1 };
  }

  async decrypt(id: string): Promise<DecryptedCredential | null> {
    const row = this.db.select().from(providerCredentials).where(eq(providerCredentials.id, id)).get();

    if (!row) return null;

    const payload: EncryptedPayload = JSON.parse(row.encryptedValue);
    const plaintextKey = decrypt(payload, this.encryptionKey);

    return {
      id: row.id,
      provider: row.provider,
      keyName: row.keyName,
      plaintextKey,
      authType: row.authType,
      authHeader: row.authHeader,
    };
  }

  async getActiveForProvider(provider: string): Promise<DecryptedCredential[]> {
    const rows = this.db
      .select()
      .from(providerCredentials)
      .where(and(eq(providerCredentials.provider, provider), eq(providerCredentials.isActive, 1)))
      .all();

    return rows.map((row) => {
      const payload: EncryptedPayload = JSON.parse(row.encryptedValue);
      const plaintextKey = decrypt(payload, this.encryptionKey);
      return {
        id: row.id,
        provider: row.provider,
        keyName: row.keyName,
        plaintextKey,
        authType: row.authType,
        authHeader: row.authHeader,
      };
    });
  }

  async rotate(input: RotateCredentialInput): Promise<boolean> {
    const existing = this.db
      .select({ id: providerCredentials.id, provider: providerCredentials.provider })
      .from(providerCredentials)
      .where(eq(providerCredentials.id, input.id))
      .get();

    if (!existing) return false;

    const encrypted = encrypt(input.plaintextKey, this.encryptionKey);
    const serialized = JSON.stringify(encrypted);

    this.db
      .update(providerCredentials)
      .set({
        encryptedValue: serialized,
        rotatedAt: new Date().toISOString(),
      })
      .where(eq(providerCredentials.id, input.id))
      .run();

    this.audit(input.rotatedBy, "credential.rotate", {
      credentialId: input.id,
      provider: existing.provider,
    });

    return true;
  }

  async setActive(id: string, isActive: boolean, changedBy: string): Promise<boolean> {
    const existing = this.db
      .select({ id: providerCredentials.id, provider: providerCredentials.provider })
      .from(providerCredentials)
      .where(eq(providerCredentials.id, id))
      .get();

    if (!existing) return false;

    this.db
      .update(providerCredentials)
      .set({ isActive: isActive ? 1 : 0 })
      .where(eq(providerCredentials.id, id))
      .run();

    this.audit(changedBy, isActive ? "credential.activate" : "credential.deactivate", {
      credentialId: id,
      provider: existing.provider,
    });

    return true;
  }

  async markValidated(id: string): Promise<boolean> {
    const result = this.db
      .update(providerCredentials)
      .set({ lastValidated: new Date().toISOString() })
      .where(eq(providerCredentials.id, id))
      .run();

    return result.changes > 0;
  }

  async delete(id: string, deletedBy: string): Promise<boolean> {
    const existing = this.db
      .select({
        id: providerCredentials.id,
        provider: providerCredentials.provider,
        keyName: providerCredentials.keyName,
      })
      .from(providerCredentials)
      .where(eq(providerCredentials.id, id))
      .get();

    if (!existing) return false;

    this.db.delete(providerCredentials).where(eq(providerCredentials.id, id)).run();

    this.audit(deletedBy, "credential.delete", {
      credentialId: id,
      provider: existing.provider,
      keyName: existing.keyName,
    });

    return true;
  }

  private audit(adminUser: string, action: string, details: Record<string, unknown>): void {
    if (!this.auditLog) return;
    this.auditLog.log({
      adminUser,
      action,
      category: "config",
      details,
    });
  }
}
