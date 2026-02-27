import { and, desc, eq } from "drizzle-orm";
import type { DrizzleDb } from "../../db/index.js";
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
  isActive: boolean;
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
  isActive: boolean;
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
  insert(data: InsertCredentialRow): Promise<void>;
  getFullById(id: string): Promise<CredentialRow | null>;
  getSummaryById(id: string): Promise<CredentialSummaryRow | null>;
  list(provider?: string): Promise<CredentialSummaryRow[]>;
  listActiveForProvider(provider: string): Promise<CredentialRow[]>;
  updateEncryptedValue(id: string, encryptedValue: string): Promise<boolean>;
  setActive(id: string, isActive: boolean): Promise<boolean>;
  markValidated(id: string): Promise<boolean>;
  deleteById(id: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class DrizzleCredentialRepository implements ICredentialRepository {
  constructor(private readonly db: DrizzleDb) {}

  async insert(data: InsertCredentialRow): Promise<void> {
    await this.db.insert(providerCredentials).values({
      id: data.id,
      provider: data.provider,
      keyName: data.keyName,
      encryptedValue: data.encryptedValue,
      authType: data.authType,
      authHeader: data.authHeader,
      isActive: true,
      createdBy: data.createdBy,
    });
  }

  async getFullById(id: string): Promise<CredentialRow | null> {
    const row = (await this.db.select().from(providerCredentials).where(eq(providerCredentials.id, id)))[0];
    return row ? toFullRow(row) : null;
  }

  async getSummaryById(id: string): Promise<CredentialSummaryRow | null> {
    const row = (
      await this.db
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
    )[0];
    return row ?? null;
  }

  async list(provider?: string): Promise<CredentialSummaryRow[]> {
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
      .orderBy(desc(providerCredentials.createdAt));
  }

  async listActiveForProvider(provider: string): Promise<CredentialRow[]> {
    const rows = await this.db
      .select()
      .from(providerCredentials)
      .where(and(eq(providerCredentials.provider, provider), eq(providerCredentials.isActive, true)));
    return rows.map(toFullRow);
  }

  async updateEncryptedValue(id: string, encryptedValue: string): Promise<boolean> {
    const result = await this.db
      .update(providerCredentials)
      .set({ encryptedValue, rotatedAt: new Date().toISOString() })
      .where(eq(providerCredentials.id, id))
      .returning({ id: providerCredentials.id });
    return result.length > 0;
  }

  async setActive(id: string, isActive: boolean): Promise<boolean> {
    const result = await this.db
      .update(providerCredentials)
      .set({ isActive })
      .where(eq(providerCredentials.id, id))
      .returning({ id: providerCredentials.id });
    return result.length > 0;
  }

  async markValidated(id: string): Promise<boolean> {
    const result = await this.db
      .update(providerCredentials)
      .set({ lastValidated: new Date().toISOString() })
      .where(eq(providerCredentials.id, id))
      .returning({ id: providerCredentials.id });
    return result.length > 0;
  }

  async deleteById(id: string): Promise<boolean> {
    const result = await this.db
      .delete(providerCredentials)
      .where(eq(providerCredentials.id, id))
      .returning({ id: providerCredentials.id });
    return result.length > 0;
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
