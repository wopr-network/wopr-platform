import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import type { DrizzleDb } from "@wopr-network/platform-core/db/index";
import { tenantApiKeys } from "@wopr-network/platform-core/db/schema/tenant-api-keys";
import type { Provider } from "@wopr-network/platform-core/security";
import { DrizzleKeyResolutionRepository } from "@wopr-network/platform-core/security";
import {
  beginTestTransaction,
  createTestDb,
  endTestTransaction,
  rollbackTestTransaction,
} from "@wopr-network/platform-core/test/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

let db: DrizzleDb;
let pool: PGlite;

async function insertKey(tenantId: string, provider: Provider, encryptedKey: string): Promise<void> {
  const now = Date.now();
  await db
    .insert(tenantApiKeys)
    .values({ id: randomUUID(), tenantId, provider, label: "", encryptedKey, createdAt: now, updatedAt: now });
}

beforeAll(async () => {
  ({ db, pool } = await createTestDb());
  await beginTestTransaction(pool);
});

afterAll(async () => {
  await endTestTransaction(pool);
  await pool.close();
});

describe("DrizzleKeyResolutionRepository", () => {
  let repo: DrizzleKeyResolutionRepository;

  beforeEach(async () => {
    await rollbackTestTransaction(pool);
    repo = new DrizzleKeyResolutionRepository(db);
  });

  it("returns the encrypted key for a matching tenant and provider", async () => {
    const payload = JSON.stringify({ iv: "aaa", authTag: "bbb", ciphertext: "ccc" });
    await insertKey("tenant-1", "anthropic", payload);

    const result = await repo.findEncryptedKey("tenant-1", "anthropic");

    expect(result).not.toBeNull();
    expect(result?.encryptedKey).toBe(payload);
  });

  it("returns null when no key exists for the tenant", async () => {
    const result = await repo.findEncryptedKey("nonexistent-tenant", "anthropic");
    expect(result).toBeNull();
  });

  it("returns null when no key exists for the provider", async () => {
    const payload = JSON.stringify({ iv: "aaa", authTag: "bbb", ciphertext: "ccc" });
    await insertKey("tenant-1", "anthropic", payload);

    const result = await repo.findEncryptedKey("tenant-1", "openai");
    expect(result).toBeNull();
  });

  it("isolates keys between tenants (cross-tenant isolation)", async () => {
    const payloadA = JSON.stringify({ iv: "aaa", authTag: "bbb", ciphertext: "tenant-a-secret" });
    const payloadB = JSON.stringify({ iv: "xxx", authTag: "yyy", ciphertext: "tenant-b-secret" });
    await insertKey("tenant-a", "anthropic", payloadA);
    await insertKey("tenant-b", "anthropic", payloadB);

    const resultA = await repo.findEncryptedKey("tenant-a", "anthropic");
    const resultB = await repo.findEncryptedKey("tenant-b", "anthropic");

    expect(resultA).not.toBeNull();
    expect(resultB).not.toBeNull();
    expect(resultA?.encryptedKey).toBe(payloadA);
    expect(resultB?.encryptedKey).toBe(payloadB);
    expect(resultA?.encryptedKey).not.toBe(resultB?.encryptedKey);
  });

  it("tenant A cannot see tenant B keys", async () => {
    const payload = JSON.stringify({ iv: "aaa", authTag: "bbb", ciphertext: "only-for-b" });
    await insertKey("tenant-b", "openai", payload);

    const result = await repo.findEncryptedKey("tenant-a", "openai");
    expect(result).toBeNull();
  });

  it("returns correct key when tenant has multiple providers", async () => {
    const anthropicPayload = JSON.stringify({ iv: "a1", authTag: "a2", ciphertext: "anthropic-key" });
    const openaiPayload = JSON.stringify({ iv: "o1", authTag: "o2", ciphertext: "openai-key" });
    await insertKey("tenant-1", "anthropic", anthropicPayload);
    await insertKey("tenant-1", "openai", openaiPayload);

    const anthropicResult = await repo.findEncryptedKey("tenant-1", "anthropic");
    const openaiResult = await repo.findEncryptedKey("tenant-1", "openai");

    expect(anthropicResult?.encryptedKey).toBe(anthropicPayload);
    expect(openaiResult?.encryptedKey).toBe(openaiPayload);
  });
});
