import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DrizzleDb } from "../../db/index.js";
import { DrizzleOrgMembershipRepository } from "../../fleet/org-membership-repository.js";
import { createTestDb } from "../../test/db.js";
import { encrypt, generateInstanceKey } from "../encryption.js";
import type { EncryptedPayload, Provider } from "../types.js";
import { resolveApiKey } from "./key-resolution.js";
import { resolveApiKeyWithOrgFallback } from "./org-key-resolution.js";

async function insertTenantKey(
  pool: PGlite,
  tenantId: string,
  provider: string,
  encryptedKey: EncryptedPayload,
): Promise<void> {
  const now = Date.now();
  await pool.query(
    "INSERT INTO tenant_api_keys (id, tenant_id, provider, label, encrypted_key, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7)",
    [randomUUID(), tenantId, provider, "", JSON.stringify(encryptedKey), now, now],
  );
}

async function insertOrgMembership(pool: PGlite, orgTenantId: string, memberTenantId: string): Promise<void> {
  await pool.query("INSERT INTO org_memberships (org_tenant_id, member_tenant_id, created_at) VALUES ($1, $2, $3)", [
    orgTenantId,
    memberTenantId,
    Date.now(),
  ]);
}

describe("resolveApiKeyWithOrgFallback", () => {
  let db: DrizzleDb;
  let pool: PGlite;
  let membershipRepo: DrizzleOrgMembershipRepository;
  let encryptionKey: Buffer;
  let orgEncryptionKey: Buffer;
  const pooled = new Map<Provider, string>();

  beforeEach(async () => {
    ({ db, pool } = await createTestDb());
    membershipRepo = new DrizzleOrgMembershipRepository(db);
    encryptionKey = generateInstanceKey();
    orgEncryptionKey = generateInstanceKey();
  });

  afterEach(async () => {
    await pool.close();
  });

  it("returns personal key when member has one (no org fallback)", async () => {
    const encrypted = encrypt("sk-personal", encryptionKey);
    await insertTenantKey(pool, "member-1", "anthropic", encrypted);
    await insertOrgMembership(pool, "org-1", "member-1");

    const orgEncrypted = encrypt("sk-org", orgEncryptionKey);
    await insertTenantKey(pool, "org-1", "anthropic", orgEncrypted);

    const result = await resolveApiKeyWithOrgFallback(
      (tid, prov, encKey) => resolveApiKey(db, tid, prov, encKey, new Map()).then((r) => r?.key ?? null),
      "member-1",
      "anthropic",
      encryptionKey,
      pooled,
      (tenantId) => (tenantId === "org-1" ? orgEncryptionKey : encryptionKey),
      membershipRepo,
    );
    expect(result).not.toBeNull();
    expect(result?.key).toBe("sk-personal");
    expect(result?.source).toBe("tenant");
  });

  it("falls back to org key when member has no personal key", async () => {
    await insertOrgMembership(pool, "org-1", "member-1");

    const orgEncrypted = encrypt("sk-org-key", orgEncryptionKey);
    await insertTenantKey(pool, "org-1", "anthropic", orgEncrypted);

    const result = await resolveApiKeyWithOrgFallback(
      (tid, prov, encKey) => resolveApiKey(db, tid, prov, encKey, new Map()).then((r) => r?.key ?? null),
      "member-1",
      "anthropic",
      encryptionKey,
      pooled,
      (tenantId) => (tenantId === "org-1" ? orgEncryptionKey : encryptionKey),
      membershipRepo,
    );
    expect(result).not.toBeNull();
    expect(result?.key).toBe("sk-org-key");
    expect(result?.source).toBe("org");
  });

  it("falls back to pooled when neither member nor org has a key", async () => {
    await insertOrgMembership(pool, "org-1", "member-1");

    const pooledKeys = new Map<Provider, string>([["anthropic", "sk-pooled"]]);

    const result = await resolveApiKeyWithOrgFallback(
      (tid, prov, encKey) => resolveApiKey(db, tid, prov, encKey, new Map()).then((r) => r?.key ?? null),
      "member-1",
      "anthropic",
      encryptionKey,
      pooledKeys,
      () => encryptionKey,
      membershipRepo,
    );
    expect(result).not.toBeNull();
    expect(result?.key).toBe("sk-pooled");
    expect(result?.source).toBe("pooled");
  });

  it("returns null when no key exists anywhere", async () => {
    const result = await resolveApiKeyWithOrgFallback(
      (tid, prov, encKey) => resolveApiKey(db, tid, prov, encKey, new Map()).then((r) => r?.key ?? null),
      "member-1",
      "anthropic",
      encryptionKey,
      pooled,
      () => encryptionKey,
      membershipRepo,
    );
    expect(result).toBeNull();
  });

  it("works for tenants not in any org (same as resolveApiKey)", async () => {
    const encrypted = encrypt("sk-solo", encryptionKey);
    await insertTenantKey(pool, "solo-tenant", "openai", encrypted);

    const result = await resolveApiKeyWithOrgFallback(
      (tid, prov, encKey) => resolveApiKey(db, tid, prov, encKey, new Map()).then((r) => r?.key ?? null),
      "solo-tenant",
      "openai",
      encryptionKey,
      pooled,
      () => encryptionKey,
      membershipRepo,
    );
    expect(result).not.toBeNull();
    expect(result?.key).toBe("sk-solo");
    expect(result?.source).toBe("tenant");
  });

  it("full chain: personal > org > pooled > null", async () => {
    const memberKey = generateInstanceKey();
    const orgKey = generateInstanceKey();
    const pooledKeys = new Map<Provider, string>([["discord", "pooled-discord"]]);
    const deriveKey = (tid: string) => (tid === "org-1" ? orgKey : memberKey);

    await insertOrgMembership(pool, "org-1", "m1");
    await insertTenantKey(pool, "m1", "anthropic", encrypt("personal-anthropic", memberKey));
    await insertTenantKey(pool, "org-1", "openai", encrypt("org-openai", orgKey));

    const lookupKey = (tid: string, prov: Provider, encKey: Buffer) =>
      resolveApiKey(db, tid, prov, encKey, new Map()).then((r) => r?.key ?? null);

    // anthropic: personal wins
    const r1 = await resolveApiKeyWithOrgFallback(
      lookupKey,
      "m1",
      "anthropic",
      memberKey,
      pooledKeys,
      deriveKey,
      membershipRepo,
    );
    expect(r1?.source).toBe("tenant");
    expect(r1?.key).toBe("personal-anthropic");

    // openai: org fallback
    const r2 = await resolveApiKeyWithOrgFallback(
      lookupKey,
      "m1",
      "openai",
      memberKey,
      pooledKeys,
      deriveKey,
      membershipRepo,
    );
    expect(r2?.source).toBe("org");
    expect(r2?.key).toBe("org-openai");

    // discord: pooled fallback
    const r3 = await resolveApiKeyWithOrgFallback(
      lookupKey,
      "m1",
      "discord",
      memberKey,
      pooledKeys,
      deriveKey,
      membershipRepo,
    );
    expect(r3?.source).toBe("pooled");
    expect(r3?.key).toBe("pooled-discord");

    // google: null
    const r4 = await resolveApiKeyWithOrgFallback(
      lookupKey,
      "m1",
      "google",
      memberKey,
      new Map(),
      deriveKey,
      membershipRepo,
    );
    expect(r4).toBeNull();
  });
});
