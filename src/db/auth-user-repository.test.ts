import type { Pool } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type AuthUser, BetterAuthUserRepository } from "./auth-user-repository.js";

function createMockPool() {
  return {
    query: vi.fn(),
  } as unknown as Pool;
}

describe("BetterAuthUserRepository", () => {
  let pool: Pool;
  let repo: BetterAuthUserRepository;

  beforeEach(() => {
    pool = createMockPool();
    repo = new BetterAuthUserRepository(pool);
  });

  describe("getUser", () => {
    it("returns user when found", async () => {
      const user: AuthUser = {
        id: "u-1",
        name: "Alice",
        email: "alice@test.com",
        image: null,
        twoFactorEnabled: false,
      };
      (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [user] });

      const result = await repo.getUser("u-1");
      expect(result).toEqual(user);
      expect(pool.query).toHaveBeenCalledWith(expect.stringContaining("SELECT id, name, email, image"), ["u-1"]);
    });

    it("returns null when user not found", async () => {
      (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [] });
      expect(await repo.getUser("nonexistent")).toBeNull();
    });
  });

  describe("updateUser", () => {
    it("updates name and returns updated user", async () => {
      const updated: AuthUser = {
        id: "u-1",
        name: "Bob",
        email: "alice@test.com",
        image: null,
        twoFactorEnabled: false,
      };
      const queryMock = pool.query as ReturnType<typeof vi.fn>;
      queryMock.mockResolvedValueOnce({ rows: [] }); // UPDATE
      queryMock.mockResolvedValueOnce({ rows: [updated] }); // SELECT

      const result = await repo.updateUser("u-1", { name: "Bob" });
      expect(result.name).toBe("Bob");
    });

    it("updates image to null", async () => {
      const updated: AuthUser = {
        id: "u-1",
        name: "Alice",
        email: "alice@test.com",
        image: null,
        twoFactorEnabled: false,
      };
      const queryMock = pool.query as ReturnType<typeof vi.fn>;
      queryMock.mockResolvedValueOnce({ rows: [] });
      queryMock.mockResolvedValueOnce({ rows: [updated] });

      const result = await repo.updateUser("u-1", { image: null });
      expect(result.image).toBeNull();
    });

    it("throws when user not found after update", async () => {
      const queryMock = pool.query as ReturnType<typeof vi.fn>;
      // No fields to update: skips UPDATE, goes straight to SELECT which returns empty
      queryMock.mockResolvedValueOnce({ rows: [] });

      await expect(repo.updateUser("u-1", {})).rejects.toThrow("User not found: u-1");
    });

    it("updates both name and image in one call", async () => {
      const updated: AuthUser = {
        id: "u-1",
        name: "Carol",
        email: "carol@test.com",
        image: "https://example.com/img.png",
        twoFactorEnabled: false,
      };
      const queryMock = pool.query as ReturnType<typeof vi.fn>;
      queryMock.mockResolvedValueOnce({ rows: [] });
      queryMock.mockResolvedValueOnce({ rows: [updated] });

      const result = await repo.updateUser("u-1", { name: "Carol", image: "https://example.com/img.png" });
      expect(result.name).toBe("Carol");
      expect(result.image).toBe("https://example.com/img.png");
    });
  });

  describe("changePassword", () => {
    it("returns false when no credential account exists", async () => {
      (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [] });
      expect(await repo.changePassword("u-1", "old", "new")).toBe(false);
    });

    it("returns false when password field is null/undefined", async () => {
      (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [{ password: null }] });
      expect(await repo.changePassword("u-1", "old", "new")).toBe(false);
    });
  });

  describe("listAccounts", () => {
    it("returns mapped accounts", async () => {
      (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        rows: [
          { id: "acc-1", provider_id: "google", account_id: "goog-123" },
          { id: "acc-2", provider_id: "github", account_id: "gh-456" },
        ],
      });

      const accounts = await repo.listAccounts("u-1");
      expect(accounts).toEqual([
        { id: "acc-1", providerId: "google", accountId: "goog-123" },
        { id: "acc-2", providerId: "github", accountId: "gh-456" },
      ]);
    });

    it("returns empty array when no accounts", async () => {
      (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [] });
      expect(await repo.listAccounts("u-1")).toEqual([]);
    });

    it("queries with the correct userId", async () => {
      (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [] });
      await repo.listAccounts("user-xyz");
      expect(pool.query).toHaveBeenCalledWith(expect.any(String), ["user-xyz"]);
    });
  });

  describe("unlinkAccount", () => {
    it("returns true when account deleted", async () => {
      (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rowCount: 1 });
      expect(await repo.unlinkAccount("u-1", "google")).toBe(true);
    });

    it("returns false when no account found", async () => {
      (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rowCount: 0 });
      expect(await repo.unlinkAccount("u-1", "google")).toBe(false);
    });

    it("returns false when rowCount is null", async () => {
      (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rowCount: null });
      expect(await repo.unlinkAccount("u-1", "google")).toBe(false);
    });
  });
});
