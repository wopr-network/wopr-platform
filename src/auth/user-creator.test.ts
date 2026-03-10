import type { RoleStore } from "@wopr-network/platform-core/admin";
import { describe, expect, it, vi } from "vitest";
import { createUserCreator } from "./user-creator.js";

// Minimal mock RoleStore
function mockRoleStore(adminCount: number) {
  const calls: Array<{ userId: string; tenantId: string; role: string; grantedBy: string | null }> = [];
  return {
    store: {
      countPlatformAdmins: vi.fn().mockResolvedValue(adminCount),
      setRole: vi.fn(async (userId: string, tenantId: string, role: string, grantedBy: string | null) => {
        calls.push({ userId, tenantId, role, grantedBy });
      }),
    } as unknown as RoleStore,
    calls,
  };
}

describe("createUserCreator", () => {
  it("promotes first user when no admins exist", async () => {
    const { store, calls } = mockRoleStore(0);
    const creator = await createUserCreator(store);

    await creator.createUser("user-1");

    expect(store.setRole).toHaveBeenCalledOnce();
    expect(calls[0]).toEqual({
      userId: "user-1",
      tenantId: "*",
      role: "platform_admin",
      grantedBy: "bootstrap",
    });
  });

  it("second call after promotion does NOT grant role", async () => {
    const { store } = mockRoleStore(0);
    const creator = await createUserCreator(store);

    await creator.createUser("user-1");
    await creator.createUser("user-2");

    expect(store.setRole).toHaveBeenCalledOnce();
  });

  it("does not promote when admins already exist", async () => {
    const { store } = mockRoleStore(1);
    const creator = await createUserCreator(store);

    await creator.createUser("user-1");
    await creator.createUser("user-2");

    expect(store.setRole).not.toHaveBeenCalled();
  });

  it("retries bootstrap on transient setRole failure", async () => {
    const calls: Array<{ userId: string }> = [];
    let failOnce = true;
    const store = {
      countPlatformAdmins: vi.fn().mockResolvedValue(0),
      setRole: vi.fn(async (userId: string) => {
        if (failOnce) {
          failOnce = false;
          throw new Error("transient DB error");
        }
        calls.push({ userId });
      }),
    } as unknown as RoleStore;

    const creator = await createUserCreator(store);

    // First call fails — should NOT permanently disable bootstrap
    await expect(creator.createUser("user-1")).rejects.toThrow("transient DB error");

    // Second call should still attempt promotion
    await creator.createUser("user-2");

    expect(calls).toHaveLength(1);
    expect(calls[0].userId).toBe("user-2");
  });

  it("concurrent calls promote only the first user (race condition)", async () => {
    const calls: Array<{ userId: string }> = [];
    const store = {
      countPlatformAdmins: vi.fn().mockResolvedValue(0),
      setRole: vi.fn(async (userId: string) => {
        calls.push({ userId });
      }),
    } as unknown as RoleStore;

    const creator = await createUserCreator(store);

    // Simulate concurrent signups
    await Promise.all([creator.createUser("user-a"), creator.createUser("user-b")]);

    // Only one should be promoted
    expect(store.setRole).toHaveBeenCalledOnce();
  });
});
