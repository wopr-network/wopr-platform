import { createHmac, randomUUID } from "node:crypto";
import type { AdminAuditLog } from "../../admin/audit-log.js";
import { decrypt, encrypt, generateInstanceKey } from "../encryption.js";
import type { EncryptedPayload } from "../types.js";
import type { ICredentialRepository } from "./credential-repository.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Auth mechanism for injecting the key into upstream requests. */
export type AuthType = "header" | "bearer" | "basic";

/** Input for creating a new credential. */
export interface CreateCredentialInput {
  provider: string;
  keyName: string;
  /** Plaintext API key — encrypted before storage, never persisted raw. */
  plaintextKey: string;
  authType: AuthType;
  authHeader?: string;
  createdBy: string;
}

/** Input for rotating an existing credential's key. */
export interface RotateCredentialInput {
  id: string;
  /** New plaintext API key. */
  plaintextKey: string;
  rotatedBy: string;
}

/** A credential record with the encrypted value omitted for listing. */
export interface CredentialSummary {
  id: string;
  provider: string;
  keyName: string;
  authType: string;
  authHeader: string | null;
  isActive: boolean;
  lastValidated: string | null;
  createdAt: string;
  rotatedAt: string | null;
  createdBy: string;
}

/** A decrypted credential ready for gateway injection. */
export interface DecryptedCredential {
  id: string;
  provider: string;
  keyName: string;
  /** The plaintext API key. MUST be discarded after use. */
  plaintextKey: string;
  authType: string;
  authHeader: string | null;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/**
 * Credential vault store — encrypted CRUD for platform-level provider API keys.
 *
 * SECURITY:
 * - Keys are encrypted with AES-256-GCM before storage.
 * - The encryption key is derived from a platform secret (env var).
 * - Plaintext keys are never logged, persisted, or returned in list operations.
 * - All mutations are audit-logged.
 */
export class CredentialVaultStore {
  private readonly repo: ICredentialRepository;
  private readonly encryptionKey: Buffer;
  private readonly auditLog: AdminAuditLog | null;

  constructor(repo: ICredentialRepository, encryptionKey: Buffer, auditLog?: AdminAuditLog) {
    this.repo = repo;
    this.encryptionKey = encryptionKey;
    this.auditLog = auditLog ?? null;
  }

  /** Create a new provider credential. Returns the record ID. */
  async create(input: CreateCredentialInput): Promise<string> {
    const id = randomUUID();
    const encrypted = encrypt(input.plaintextKey, this.encryptionKey);
    const serialized = JSON.stringify(encrypted);

    await this.repo.insert({
      id,
      provider: input.provider,
      keyName: input.keyName,
      encryptedValue: serialized,
      authType: input.authType,
      authHeader: input.authHeader ?? null,
      createdBy: input.createdBy,
    });

    this.audit(input.createdBy, "credential.create", {
      credentialId: id,
      provider: input.provider,
      keyName: input.keyName,
    });

    return id;
  }

  /** List all credentials for a provider (or all providers). Never returns encrypted values. */
  async list(provider?: string): Promise<CredentialSummary[]> {
    const rows = await this.repo.list(provider);
    return rows.map((r) => ({ ...r, isActive: r.isActive }));
  }

  /** Get a single credential summary by ID. */
  async getById(id: string): Promise<CredentialSummary | null> {
    const row = await this.repo.getSummaryById(id);
    if (!row) return null;
    return { ...row, isActive: row.isActive };
  }

  /**
   * Decrypt and return a credential's key. For gateway use only.
   *
   * SECURITY: The returned plaintext key MUST be discarded after use.
   */
  async decrypt(id: string): Promise<DecryptedCredential | null> {
    const row = await this.repo.getFullById(id);
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

  /**
   * Get the active credential(s) for a provider, decrypted.
   * Returns all active keys for load distribution; caller picks one.
   *
   * SECURITY: Returned keys MUST be discarded after use.
   */
  async getActiveForProvider(provider: string): Promise<DecryptedCredential[]> {
    const rows = await this.repo.listActiveForProvider(provider);
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

  /** Rotate a credential's key. Encrypts the new key and records the rotation timestamp. */
  async rotate(input: RotateCredentialInput): Promise<boolean> {
    const existing = await this.repo.getSummaryById(input.id);
    if (!existing) return false;

    const encrypted = encrypt(input.plaintextKey, this.encryptionKey);
    const serialized = JSON.stringify(encrypted);
    await this.repo.updateEncryptedValue(input.id, serialized);

    this.audit(input.rotatedBy, "credential.rotate", {
      credentialId: input.id,
      provider: existing.provider,
    });

    return true;
  }

  /** Mark a credential as active or inactive. */
  async setActive(id: string, isActive: boolean, changedBy: string): Promise<boolean> {
    const existing = await this.repo.getSummaryById(id);
    if (!existing) return false;

    await this.repo.setActive(id, isActive);

    this.audit(changedBy, isActive ? "credential.activate" : "credential.deactivate", {
      credentialId: id,
      provider: existing.provider,
    });

    return true;
  }

  /** Record a successful validation timestamp. */
  async markValidated(id: string): Promise<boolean> {
    return this.repo.markValidated(id);
  }

  /** Permanently delete a credential. */
  async delete(id: string, deletedBy: string): Promise<boolean> {
    const existing = await this.repo.getSummaryById(id);
    if (!existing) return false;

    await this.repo.deleteById(id);

    this.audit(deletedBy, "credential.delete", {
      credentialId: id,
      provider: existing.provider,
      keyName: existing.keyName,
    });

    return true;
  }

  // -----------------------------------------------------------------------
  // Audit helper
  // -----------------------------------------------------------------------

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

/**
 * Derive the credential vault encryption key from a platform secret.
 * If no secret is provided, generates a random key (suitable for tests only).
 */
export function getVaultEncryptionKey(platformSecret?: string): Buffer {
  if (platformSecret) {
    return createHmac("sha256", platformSecret).update("credential-vault").digest();
  }
  return generateInstanceKey();
}
