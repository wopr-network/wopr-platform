export type {
  CredentialRow,
  CredentialSummaryRow,
  ICredentialRepository,
} from "./credential-repository.js";
export { DrizzleCredentialRepository } from "./credential-repository.js";
export type { RotationResult } from "./key-rotation.js";
export { reEncryptAllCredentials } from "./key-rotation.js";
export type { MigrationResult } from "./migrate-plaintext.js";
export { migratePlaintextCredentials } from "./migrate-plaintext.js";
export type { PlaintextFinding } from "./migration-check.js";
export { auditCredentialEncryption } from "./migration-check.js";
export type {
  AuthType,
  CreateCredentialInput,
  CredentialSummary,
  DecryptedCredential,
  RotateCredentialInput,
} from "./store.js";
export { CredentialVaultStore, getVaultEncryptionKey } from "./store.js";
