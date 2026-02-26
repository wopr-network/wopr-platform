import { eq } from "drizzle-orm";
import type { DrizzleDb } from "../db/index.js";
import { tenants } from "../db/schema/index.js";

// ---------------------------------------------------------------------------
// Domain types (no Drizzle imports)
// ---------------------------------------------------------------------------

export interface Tenant {
  id: string;
  name: string;
  slug: string | null;
  type: "personal" | "org";
  ownerId: string;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface IOrgRepository {
  createOrg(ownerId: string, name: string, slug?: string): Promise<Tenant>;
  ensurePersonalTenant(userId: string, displayName: string): Promise<Tenant>;
  getById(id: string): Promise<Tenant | null>;
  getBySlug(slug: string): Promise<Tenant | null>;
  listOrgsByOwner(ownerId: string): Promise<Tenant[]>;
  updateOrg(orgId: string, data: { name?: string; slug?: string }): Promise<Tenant>;
  updateOwner(orgId: string, newOwnerId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/** Slugify a name: lowercase, replace whitespace with hyphens, strip non-alphanumeric. */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function toTenant(row: typeof tenants.$inferSelect): Tenant {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    type: row.type as "personal" | "org",
    ownerId: row.ownerId,
    createdAt: row.createdAt,
  };
}

export class DrizzleOrgRepository implements IOrgRepository {
  constructor(private readonly db: DrizzleDb) {}

  async createOrg(ownerId: string, name: string, slug?: string): Promise<Tenant> {
    const id = crypto.randomUUID();
    const finalSlug = slug || slugify(name);
    if (!finalSlug) {
      throw Object.assign(new Error("Org name produces an empty slug; use only letters, numbers, or hyphens"), {
        status: 400,
      });
    }

    const row = (
      await this.db
        .insert(tenants)
        .values({
          id,
          name,
          slug: finalSlug,
          type: "org",
          ownerId,
          createdAt: Date.now(),
        })
        .returning()
    )[0];

    return toTenant(row);
  }

  async ensurePersonalTenant(userId: string, displayName: string): Promise<Tenant> {
    // Use userId as the tenant ID for backward compatibility
    await this.db
      .insert(tenants)
      .values({
        id: userId,
        name: displayName,
        slug: null,
        type: "personal",
        ownerId: userId,
        createdAt: Date.now(),
      })
      .onConflictDoNothing({ target: tenants.id });

    const tenant = await this.getById(userId);
    if (!tenant) throw new Error(`Personal tenant not found for user ${userId}`);
    return tenant;
  }

  async getById(id: string): Promise<Tenant | null> {
    const row = (await this.db.select().from(tenants).where(eq(tenants.id, id)))[0];
    return row ? toTenant(row) : null;
  }

  async getBySlug(slug: string): Promise<Tenant | null> {
    const row = (await this.db.select().from(tenants).where(eq(tenants.slug, slug)))[0];
    return row ? toTenant(row) : null;
  }

  async listOrgsByOwner(ownerId: string): Promise<Tenant[]> {
    const rows = await this.db.select().from(tenants).where(eq(tenants.ownerId, ownerId));
    return rows.filter((r) => r.type === "org").map(toTenant);
  }

  async updateOrg(orgId: string, data: { name?: string; slug?: string }): Promise<Tenant> {
    const updates: Partial<typeof tenants.$inferInsert> = {};
    if (data.name !== undefined) updates.name = data.name;
    if (data.slug !== undefined) updates.slug = data.slug;
    const row = (await this.db.update(tenants).set(updates).where(eq(tenants.id, orgId)).returning())[0];
    if (!row) throw new Error(`Org not found: ${orgId}`);
    return toTenant(row);
  }

  async updateOwner(orgId: string, newOwnerId: string): Promise<void> {
    await this.db.update(tenants).set({ ownerId: newOwnerId }).where(eq(tenants.id, orgId));
  }
}
