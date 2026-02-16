/**
 * Repository Interface: CredentialVaultRepository (ASYNC)
 *
 * Manages encrypted platform-level provider API keys.
 */

/** Auth mechanism for injecting the key into upstream requests. */
export type AuthType = "header" | "bearer" | "basic";

/** Input for creating a new credential. */
export interface CreateCredentialInput {
  provider: string;
  keyName: string;
  plaintextKey: string;
  authType: AuthType;
  authHeader?: string;
  createdBy: string;
}

/** Input for rotating an existing credential's key. */
export interface RotateCredentialInput {
  id: string;
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
  plaintextKey: string;
  authType: string;
  authHeader: string | null;
}

export interface CredentialVaultRepository {
  /**
   * Create a new provider credential. Returns the record ID.
   */
  create(input: CreateCredentialInput): Promise<string>;

  /**
   * List all credentials for a provider (or all providers).
   */
  list(provider?: string): Promise<CredentialSummary[]>;

  /**
   * Get a single credential summary by ID.
   */
  getById(id: string): Promise<CredentialSummary | null>;

  /**
   * Decrypt and return a credential's key.
   */
  decrypt(id: string): Promise<DecryptedCredential | null>;

  /**
   * Get the active credential(s) for a provider, decrypted.
   */
  getActiveForProvider(provider: string): Promise<DecryptedCredential[]>;

  /**
   * Rotate a credential's key.
   */
  rotate(input: RotateCredentialInput): Promise<boolean>;

  /**
   * Mark a credential as active or inactive.
   */
  setActive(id: string, isActive: boolean, changedBy: string): Promise<boolean>;

  /**
   * Record a successful validation timestamp.
   */
  markValidated(id: string): Promise<boolean>;

  /**
   * Permanently delete a credential.
   */
  delete(id: string, deletedBy: string): Promise<boolean>;
}
