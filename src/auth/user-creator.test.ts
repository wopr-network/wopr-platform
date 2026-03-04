import { describe, expect, it, vi } from "vitest";
import type { RoleStore } from "../admin/roles/role-store.js";
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
});
