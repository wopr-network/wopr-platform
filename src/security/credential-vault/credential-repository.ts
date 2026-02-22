import { and, desc, eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "../../db/schema/index.js";
import { providerCredentials } from "../../db/schema/index.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A full credential row from the database — includes encrypted value. */
export interface CredentialRow {
  id: string;
  provider: string;
  keyName: string;
  encryptedValue: string;
  authType: string;
  authHeader: string | null;
  isActive: number;
  lastValidated: string | null;
  createdAt: string;
  rotatedAt: string | null;
  createdBy: string;
}

/** A credential row without the encrypted value — for listing. */
export interface CredentialSummaryRow {
  id: string;
  provider: string;
  keyName: string;
  authType: string;
  authHeader: string | null;
  isActive: number;
  lastValidated: string | null;
  createdAt: string;
  rotatedAt: string | null;
  createdBy: string;
}

export interface InsertCredentialRow {
  id: string;
  provider: string;
  keyName: string;
  encryptedValue: string;
  authType: string;
  authHeader: string | null;
  createdBy: string;
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

/** Pure storage repository for provider credentials. No encryption logic. */
export interface ICredentialRepository {
  insert(data: InsertCredentialRow): void;
  getFullById(id: string): CredentialRow | null;
  getSummaryById(id: string): CredentialSummaryRow | null;
  list(provider?: string): CredentialSummaryRow[];
  listActiveForProvider(provider: string): CredentialRow[];
  updateEncryptedValue(id: string, encryptedValue: string): boolean;
  setActive(id: string, isActive: boolean): boolean;
  markValidated(id: string): boolean;
  deleteById(id: string): boolean;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class DrizzleCredentialRepository implements ICredentialRepository {
  constructor(private readonly db: BetterSQLite3Database<typeof schema>) {}

  insert(data: InsertCredentialRow): void {
    this.db
      .insert(providerCredentials)
      .values({
        id: data.id,
        provider: data.provider,
        keyName: data.keyName,
        encryptedValue: data.encryptedValue,
        authType: data.authType,
        authHeader: data.authHeader,
        isActive: 1,
        createdBy: data.createdBy,
      })
      .run();
  }

  getFullById(id: string): CredentialRow | null {
    const row = this.db.select().from(providerCredentials).where(eq(providerCredentials.id, id)).get();
    return row ? toFullRow(row) : null;
  }

  getSummaryById(id: string): CredentialSummaryRow | null {
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
    return row ?? null;
  }

  list(provider?: string): CredentialSummaryRow[] {
    const where = provider ? eq(providerCredentials.provider, provider) : undefined;
    return this.db
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
  }

  listActiveForProvider(provider: string): CredentialRow[] {
    return this.db
      .select()
      .from(providerCredentials)
      .where(and(eq(providerCredentials.provider, provider), eq(providerCredentials.isActive, 1)))
      .all()
      .map(toFullRow);
  }

  updateEncryptedValue(id: string, encryptedValue: string): boolean {
    const result = this.db
      .update(providerCredentials)
      .set({ encryptedValue, rotatedAt: new Date().toISOString() })
      .where(eq(providerCredentials.id, id))
      .run();
    return result.changes > 0;
  }

  setActive(id: string, isActive: boolean): boolean {
    const result = this.db
      .update(providerCredentials)
      .set({ isActive: isActive ? 1 : 0 })
      .where(eq(providerCredentials.id, id))
      .run();
    return result.changes > 0;
  }

  markValidated(id: string): boolean {
    const result = this.db
      .update(providerCredentials)
      .set({ lastValidated: new Date().toISOString() })
      .where(eq(providerCredentials.id, id))
      .run();
    return result.changes > 0;
  }

  deleteById(id: string): boolean {
    const result = this.db.delete(providerCredentials).where(eq(providerCredentials.id, id)).run();
    return result.changes > 0;
  }
}

// ---------------------------------------------------------------------------
// Row -> Domain mapper
// ---------------------------------------------------------------------------

function toFullRow(row: typeof providerCredentials.$inferSelect): CredentialRow {
  return {
    id: row.id,
    provider: row.provider,
    keyName: row.keyName,
    encryptedValue: row.encryptedValue,
    authType: row.authType,
    authHeader: row.authHeader,
    isActive: row.isActive,
    lastValidated: row.lastValidated,
    createdAt: row.createdAt,
    rotatedAt: row.rotatedAt,
    createdBy: row.createdBy,
  };
}
