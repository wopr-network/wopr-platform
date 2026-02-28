import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { IApiKeyRepository } from "./api-key-repository.js";

// In-memory mock that follows the same contract
function createMockRepo(
  rows: Array<{
    keyHash: string;
    userId: string;
    roles: string;
    expiresAt: number | null;
    revokedAt: number | null;
  }>,
): IApiKeyRepository {
  return {
    async findByHash(hash: string) {
      const now = Date.now();
      const row = rows.find(
        (r) => r.keyHash === hash && r.revokedAt === null && (r.expiresAt === null || r.expiresAt > now),
      );
      if (!row) return null;
      return { id: row.userId, roles: JSON.parse(row.roles) };
    },
  };
}

function sha256(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

describe("IApiKeyRepository contract", () => {
  const hash = sha256("test-token");

  it("returns AuthUser for valid key", async () => {
    const repo = createMockRepo([
      { keyHash: hash, userId: "user-1", roles: '["admin","user"]', expiresAt: null, revokedAt: null },
    ]);
    const user = await repo.findByHash(hash);
    expect(user).toEqual({ id: "user-1", roles: ["admin", "user"] });
  });

  it("returns null for revoked key", async () => {
    const repo = createMockRepo([
      { keyHash: hash, userId: "user-1", roles: '["admin"]', expiresAt: null, revokedAt: Date.now() - 1000 },
    ]);
    const user = await repo.findByHash(hash);
    expect(user).toBeNull();
  });

  it("returns null for expired key", async () => {
    const repo = createMockRepo([
      { keyHash: hash, userId: "user-1", roles: '["admin"]', expiresAt: Date.now() - 1000, revokedAt: null },
    ]);
    const user = await repo.findByHash(hash);
    expect(user).toBeNull();
  });

  it("returns null for unknown hash", async () => {
    const repo = createMockRepo([]);
    const user = await repo.findByHash(sha256("unknown"));
    expect(user).toBeNull();
  });
});
