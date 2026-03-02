import { and, eq } from "drizzle-orm";
import type { DrizzleDb } from "../../db/index.js";
import { tenantApiKeys } from "../../db/schema/index.js";
import type { Provider } from "../types.js";

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

/** Repository for looking up tenant BYOK keys by tenant + provider. */
export interface IKeyResolutionRepository {
  findEncryptedKey(tenantId: string, provider: Provider): Promise<{ encryptedKey: string } | null>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class DrizzleKeyResolutionRepository implements IKeyResolutionRepository {
  constructor(private readonly db: DrizzleDb) {}

  async findEncryptedKey(tenantId: string, provider: Provider): Promise<{ encryptedKey: string } | null> {
    const row = (
      await this.db
        .select({ encryptedKey: tenantApiKeys.encryptedKey })
        .from(tenantApiKeys)
        .where(and(eq(tenantApiKeys.tenantId, tenantId), eq(tenantApiKeys.provider, provider)))
    )[0];
    return row ?? null;
  }
}
