import BetterSqlite3 from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { orgMemberships } from "../../db/schema/org-memberships.js";
import { encrypt, generateInstanceKey } from "../encryption.js";
import type { Provider } from "../types.js";
import { resolveApiKeyWithOrgFallback } from "./org-key-resolution.js";
import { TenantKeyStore } from "./schema.js";

function freshDb() {
  const sqlite = new BetterSqlite3(":memory:");
  const store = new TenantKeyStore(sqlite);
  // Create org_memberships table
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS org_memberships (
      org_tenant_id TEXT NOT NULL,
      member_tenant_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (org_tenant_id, member_tenant_id)
    )
  `);
  sqlite.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_org_memberships_member_unique ON org_memberships (member_tenant_id)",
  );
  const db = drizzle(sqlite);
  return { sqlite, db, store };
}

describe("resolveApiKeyWithOrgFallback", () => {
  let sqlite: BetterSqlite3.Database;
  let db: ReturnType<typeof drizzle>;
  let store: TenantKeyStore;
  let encryptionKey: Buffer;
  let orgEncryptionKey: Buffer;
  const pooled = new Map<Provider, string>();

  beforeEach(() => {
    const fresh = freshDb();
    sqlite = fresh.sqlite;
    db = fresh.db;
    store = fresh.store;
    encryptionKey = generateInstanceKey();
    orgEncryptionKey = generateInstanceKey();
  });

  afterEach(() => {
    sqlite.close();
  });

  it("returns personal key when member has one (no org fallback)", () => {
    const encrypted = encrypt("sk-personal", encryptionKey);
    store.upsert("member-1", "anthropic", encrypted);

    // member-1 belongs to org-1
    db.insert(orgMemberships)
      .values({
        orgTenantId: "org-1",
        memberTenantId: "member-1",
        createdAt: Date.now(),
      })
      .run();

    // org-1 also has a key
    const orgEncrypted = encrypt("sk-org", orgEncryptionKey);
    store.upsert("org-1", "anthropic", orgEncrypted);

    const result = resolveApiKeyWithOrgFallback(db, "member-1", "anthropic", encryptionKey, pooled, (tenantId) =>
      tenantId === "org-1" ? orgEncryptionKey : encryptionKey,
    );
    expect(result).not.toBeNull();
    expect(result?.key).toBe("sk-personal");
    expect(result?.source).toBe("tenant");
  });

  it("falls back to org key when member has no personal key", () => {
    // member-1 belongs to org-1, no personal key
    db.insert(orgMemberships)
      .values({
        orgTenantId: "org-1",
        memberTenantId: "member-1",
        createdAt: Date.now(),
      })
      .run();

    const orgEncrypted = encrypt("sk-org-key", orgEncryptionKey);
    store.upsert("org-1", "anthropic", orgEncrypted);

    const result = resolveApiKeyWithOrgFallback(db, "member-1", "anthropic", encryptionKey, pooled, (tenantId) =>
      tenantId === "org-1" ? orgEncryptionKey : encryptionKey,
    );
    expect(result).not.toBeNull();
    expect(result?.key).toBe("sk-org-key");
    expect(result?.source).toBe("org");
  });

  it("falls back to pooled when neither member nor org has a key", () => {
    db.insert(orgMemberships)
      .values({
        orgTenantId: "org-1",
        memberTenantId: "member-1",
        createdAt: Date.now(),
      })
      .run();

    const pooledKeys = new Map<Provider, string>([["anthropic", "sk-pooled"]]);

    const result = resolveApiKeyWithOrgFallback(
      db,
      "member-1",
      "anthropic",
      encryptionKey,
      pooledKeys,
      () => encryptionKey,
    );
    expect(result).not.toBeNull();
    expect(result?.key).toBe("sk-pooled");
    expect(result?.source).toBe("pooled");
  });

  it("returns null when no key exists anywhere", () => {
    const result = resolveApiKeyWithOrgFallback(
      db,
      "member-1",
      "anthropic",
      encryptionKey,
      pooled,
      () => encryptionKey,
    );
    expect(result).toBeNull();
  });

  it("works for tenants not in any org (same as resolveApiKey)", () => {
    const encrypted = encrypt("sk-solo", encryptionKey);
    store.upsert("solo-tenant", "openai", encrypted);

    const result = resolveApiKeyWithOrgFallback(
      db,
      "solo-tenant",
      "openai",
      encryptionKey,
      pooled,
      () => encryptionKey,
    );
    expect(result).not.toBeNull();
    expect(result?.key).toBe("sk-solo");
    expect(result?.source).toBe("tenant");
  });

  it("full chain: personal > org > pooled > null", () => {
    const memberKey = generateInstanceKey();
    const orgKey = generateInstanceKey();
    const pooledKeys = new Map<Provider, string>([["discord", "pooled-discord"]]);
    const deriveKey = (tid: string) => (tid === "org-1" ? orgKey : memberKey);

    // Set up org membership
    db.insert(orgMemberships)
      .values({
        orgTenantId: "org-1",
        memberTenantId: "m1",
        createdAt: Date.now(),
      })
      .run();

    // Personal key for anthropic
    store.upsert("m1", "anthropic", encrypt("personal-anthropic", memberKey));
    // Org key for openai
    store.upsert("org-1", "openai", encrypt("org-openai", orgKey));

    // anthropic: personal wins
    const r1 = resolveApiKeyWithOrgFallback(db, "m1", "anthropic", memberKey, pooledKeys, deriveKey);
    expect(r1?.source).toBe("tenant");
    expect(r1?.key).toBe("personal-anthropic");

    // openai: org fallback
    const r2 = resolveApiKeyWithOrgFallback(db, "m1", "openai", memberKey, pooledKeys, deriveKey);
    expect(r2?.source).toBe("org");
    expect(r2?.key).toBe("org-openai");

    // discord: pooled fallback
    const r3 = resolveApiKeyWithOrgFallback(db, "m1", "discord", memberKey, pooledKeys, deriveKey);
    expect(r3?.source).toBe("pooled");
    expect(r3?.key).toBe("pooled-discord");

    // google: null
    const r4 = resolveApiKeyWithOrgFallback(db, "m1", "google", memberKey, new Map(), deriveKey);
    expect(r4).toBeNull();
  });
});
