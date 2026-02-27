import { eq } from "drizzle-orm";
import type { DrizzleDb } from "../db/index.js";
import { tenantApiKeys } from "../db/schema/index.js";
import type { ITenantKeyLookup } from "./provider-check.js";

export class DrizzleTenantKeyLookup implements ITenantKeyLookup {
  constructor(private readonly db: DrizzleDb) {}

  async findFirstByTenantId(tenantId: string): Promise<{ provider: string } | undefined> {
    const rows = await this.db
      .select({ provider: tenantApiKeys.provider })
      .from(tenantApiKeys)
      .where(eq(tenantApiKeys.tenantId, tenantId));
    return rows[0];
  }
}
