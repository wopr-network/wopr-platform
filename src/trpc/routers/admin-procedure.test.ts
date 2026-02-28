import { TRPCError } from "@trpc/server";
import { describe, expect, it } from "vitest";
import { adminProcedure, router } from "../init.js";

describe("adminProcedure", () => {
  const testRouter = router({
    adminOnly: adminProcedure.query(() => "ok"),
  });

  it("rejects unauthenticated users with UNAUTHORIZED", async () => {
    const caller = testRouter.createCaller({ user: undefined, tenantId: undefined });
    await expect(caller.adminOnly()).rejects.toThrow(TRPCError);
    await expect(caller.adminOnly()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("rejects authenticated non-admin users with FORBIDDEN", async () => {
    const caller = testRouter.createCaller({
      user: { id: "user-1", roles: ["member"] },
      tenantId: "t-1",
    });
    await expect(caller.adminOnly()).rejects.toThrow(TRPCError);
    await expect(caller.adminOnly()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects users with empty roles with FORBIDDEN", async () => {
    const caller = testRouter.createCaller({
      user: { id: "user-2", roles: [] },
      tenantId: "t-1",
    });
    await expect(caller.adminOnly()).rejects.toThrow(TRPCError);
    await expect(caller.adminOnly()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("allows platform_admin users through", async () => {
    const caller = testRouter.createCaller({
      user: { id: "admin-1", roles: ["platform_admin"] },
      tenantId: "t-1",
    });
    const result = await caller.adminOnly();
    expect(result).toBe("ok");
  });

  it("allows users with platform_admin among other roles", async () => {
    const caller = testRouter.createCaller({
      user: { id: "admin-2", roles: ["member", "platform_admin", "billing"] },
      tenantId: "t-1",
    });
    const result = await caller.adminOnly();
    expect(result).toBe("ok");
  });
});
