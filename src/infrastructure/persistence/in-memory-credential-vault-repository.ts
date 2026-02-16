import { randomUUID } from "node:crypto";
import type {
  CreateCredentialInput,
  CredentialSummary,
  CredentialVaultRepository,
  DecryptedCredential,
  RotateCredentialInput,
} from "../../domain/repositories/credential-vault-repository.js";

export class InMemoryCredentialVaultRepository implements CredentialVaultRepository {
  private readonly credentials = new Map<string, { data: CredentialSummary; plaintextKey: string }>();

  async create(input: CreateCredentialInput): Promise<string> {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.credentials.set(id, {
      data: {
        id,
        provider: input.provider,
        keyName: input.keyName,
        authType: input.authType,
        authHeader: input.authHeader ?? null,
        isActive: true,
        lastValidated: null,
        createdAt: now,
        rotatedAt: null,
        createdBy: input.createdBy,
      },
      plaintextKey: input.plaintextKey,
    });
    return id;
  }

  async list(provider?: string): Promise<CredentialSummary[]> {
    const all = Array.from(this.credentials.values()).map((c) => c.data);
    if (provider) {
      return all.filter((c) => c.provider === provider);
    }
    return all;
  }

  async getById(id: string): Promise<CredentialSummary | null> {
    const cred = this.credentials.get(id);
    return cred?.data ?? null;
  }

  async decrypt(id: string): Promise<DecryptedCredential | null> {
    const cred = this.credentials.get(id);
    if (!cred) return null;
    return {
      id: cred.data.id,
      provider: cred.data.provider,
      keyName: cred.data.keyName,
      plaintextKey: cred.plaintextKey,
      authType: cred.data.authType,
      authHeader: cred.data.authHeader,
    };
  }

  async getActiveForProvider(provider: string): Promise<DecryptedCredential[]> {
    const all = Array.from(this.credentials.values()).filter((c) => c.data.provider === provider && c.data.isActive);
    return all.map((c) => ({
      id: c.data.id,
      provider: c.data.provider,
      keyName: c.data.keyName,
      plaintextKey: c.plaintextKey,
      authType: c.data.authType,
      authHeader: c.data.authHeader,
    }));
  }

  async rotate(input: RotateCredentialInput): Promise<boolean> {
    const cred = this.credentials.get(input.id);
    if (!cred) return false;
    cred.plaintextKey = input.plaintextKey;
    cred.data.rotatedAt = new Date().toISOString();
    return true;
  }

  async setActive(id: string, isActive: boolean, _changedBy: string): Promise<boolean> {
    const cred = this.credentials.get(id);
    if (!cred) return false;
    cred.data.isActive = isActive;
    return true;
  }

  async markValidated(id: string): Promise<boolean> {
    const cred = this.credentials.get(id);
    if (!cred) return false;
    cred.data.lastValidated = new Date().toISOString();
    return true;
  }

  async delete(id: string, _deletedBy: string): Promise<boolean> {
    return this.credentials.delete(id);
  }

  reset(): void {
    this.credentials.clear();
  }
}
