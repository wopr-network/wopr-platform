import { and, eq, gt, isNull, or } from "drizzle-orm";
import type { DrizzleDb } from "../db/index.js";
import { platformApiKeys } from "../db/schema/platform-api-keys.js";
import type { AuthUser } from "./index.js";

export interface IApiKeyRepository {
  /** Look up an API key by its SHA-256 hash. Returns null if not found, revoked, or expired. */
  findByHash(keyHash: string): Promise<AuthUser | null>;
}

export class DrizzleApiKeyRepository implements IApiKeyRepository {
  constructor(private readonly db: DrizzleDb) {}

  async findByHash(keyHash: string): Promise<AuthUser | null> {
    const now = Date.now();
    const rows = await this.db
      .select({
        userId: platformApiKeys.userId,
        roles: platformApiKeys.roles,
      })
      .from(platformApiKeys)
      .where(
        and(
          eq(platformApiKeys.keyHash, keyHash),
          isNull(platformApiKeys.revokedAt),
          or(isNull(platformApiKeys.expiresAt), gt(platformApiKeys.expiresAt, now)),
        ),
      )
      .limit(1);

    const row = rows[0];
    if (!row) return null;

    let roles: string[];
    try {
      roles = JSON.parse(row.roles) as string[];
    } catch {
      return null;
    }

    return {
      id: row.userId,
      roles,
    };
  }
}
