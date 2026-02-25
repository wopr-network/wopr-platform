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
  createOrg(ownerId: string, name: string, slug?: string): Tenant;
  ensurePersonalTenant(userId: string, displayName: string): Tenant;
  getById(id: string): Tenant | null;
  getBySlug(slug: string): Tenant | null;
  listOrgsByOwner(ownerId: string): Tenant[];
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

  createOrg(ownerId: string, name: string, slug?: string): Tenant {
    const id = crypto.randomUUID();
    const finalSlug = slug || slugify(name);

    const row = this.db
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
      .get();

    return toTenant(row);
  }

  ensurePersonalTenant(userId: string, displayName: string): Tenant {
    // Use userId as the tenant ID for backward compatibility
    this.db
      .insert(tenants)
      .values({
        id: userId,
        name: displayName,
        slug: null,
        type: "personal",
        ownerId: userId,
        createdAt: Date.now(),
      })
      .onConflictDoNothing({ target: tenants.id })
      .run();

    const tenant = this.getById(userId);
    if (!tenant) throw new Error(`Personal tenant not found for user ${userId}`);
    return tenant;
  }

  getById(id: string): Tenant | null {
    const row = this.db.select().from(tenants).where(eq(tenants.id, id)).get();
    return row ? toTenant(row) : null;
  }

  getBySlug(slug: string): Tenant | null {
    const row = this.db.select().from(tenants).where(eq(tenants.slug, slug)).get();
    return row ? toTenant(row) : null;
  }

  listOrgsByOwner(ownerId: string): Tenant[] {
    const rows = this.db
      .select()
      .from(tenants)
      .where(eq(tenants.ownerId, ownerId))
      .all()
      .filter((r) => r.type === "org");
    return rows.map(toTenant);
  }
}
