import { and, eq } from "drizzle-orm";
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
    await this.db.insert(tenantAddons).values({ tenantId, addonKey }).onConflictDoNothing();
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
