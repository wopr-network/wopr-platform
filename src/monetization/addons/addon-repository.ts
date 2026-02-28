import { and, eq, sql } from "drizzle-orm";
import type { DrizzleDb } from "../../db/index.js";
import { tenantAddons } from "../../db/schema/tenant-addons.js";
import type { AddonKey } from "./addon-catalog.js";
import { ADDON_KEYS } from "./addon-catalog.js";

export interface TenantAddon {
  tenantId: string;
  addonKey: AddonKey;
  enabledAt: Date;
}

export interface ITenantAddonRepository {
  list(tenantId: string): Promise<TenantAddon[]>;
  enable(tenantId: string, addonKey: AddonKey): Promise<void>;
  disable(tenantId: string, addonKey: AddonKey): Promise<void>;
  isEnabled(tenantId: string, addonKey: AddonKey): Promise<boolean>;
}

export class DrizzleTenantAddonRepository implements ITenantAddonRepository {
  constructor(private readonly db: DrizzleDb) {}

  async list(tenantId: string): Promise<TenantAddon[]> {
    const rows = await this.db.select().from(tenantAddons).where(eq(tenantAddons.tenantId, tenantId));
    return rows.map((r) => ({
      tenantId: r.tenantId,
      addonKey: r.addonKey as AddonKey,
      enabledAt: r.enabledAt,
    }));
  }

  async enable(tenantId: string, addonKey: AddonKey): Promise<void> {
    if (!ADDON_KEYS.includes(addonKey)) {
      throw new Error(`Unknown addon key: ${addonKey}`);
    }
    // raw SQL: Drizzle cannot express INSERT ON CONFLICT DO NOTHING for upsert
    await this.db.execute(
      sql`INSERT INTO tenant_addons (tenant_id, addon_key)
          VALUES (${tenantId}, ${addonKey})
          ON CONFLICT (tenant_id, addon_key) DO NOTHING`,
    );
  }

  async disable(tenantId: string, addonKey: AddonKey): Promise<void> {
    await this.db
      .delete(tenantAddons)
      .where(and(eq(tenantAddons.tenantId, tenantId), eq(tenantAddons.addonKey, addonKey)));
  }

  async isEnabled(tenantId: string, addonKey: AddonKey): Promise<boolean> {
    const rows = await this.db
      .select({ addonKey: tenantAddons.addonKey })
      .from(tenantAddons)
      .where(and(eq(tenantAddons.tenantId, tenantId), eq(tenantAddons.addonKey, addonKey)))
      .limit(1);
    return rows.length > 0;
  }
}
