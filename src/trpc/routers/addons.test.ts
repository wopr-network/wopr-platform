/**
 * tRPC addons router tests — WOP-1183
 */

import type { PGlite } from "@electric-sql/pglite";
import { TRPCError } from "@trpc/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DrizzleDb } from "../../db/index.js";
import { ADDON_KEYS } from "../../monetization/addons/addon-catalog.js";
import { DrizzleTenantAddonRepository } from "../../monetization/addons/addon-repository.js";
import { createTestDb, truncateAllTables } from "../../test/db.js";
import { appRouter } from "../index.js";
import { setTrpcOrgMemberRepo } from "../init.js";
import { setAddonRouterDeps } from "./addons.js";

let pool: PGlite;
let db: DrizzleDb;

function authedCtx(tenantId: string) {
  return {
    user: { id: `user-${tenantId}`, roles: ["user"] },
    tenantId,
  };
}

function unauthCtx() {
  return { user: undefined as undefined, tenantId: undefined as string | undefined };
}

beforeAll(async () => {
  ({ db, pool } = await createTestDb());
  setTrpcOrgMemberRepo({
    findMember: async (_userId: string, orgId: string) => ({
      id: "m1",
      orgId,
      userId: `user-${orgId}`,
      role: "owner" as const,
      joinedAt: Date.now(),
    }),
    listMembers: async () => [],
    addMember: async () => {},
    updateMemberRole: async () => {},
    removeMember: async () => {},
    countAdminsAndOwners: async () => 1,
    listInvites: async () => [],
    createInvite: async () => {},
    findInviteById: async () => null,
    findInviteByToken: async () => null,
    deleteInvite: async () => {},
    deleteAllMembers: async () => {},
    deleteAllInvites: async () => {},
  });
});

afterAll(async () => {
  await pool.close();
});

describe("addons router", () => {
  beforeEach(async () => {
    await truncateAllTables(pool);
    setAddonRouterDeps({
      addonRepo: new DrizzleTenantAddonRepository(db),
    });
  });

  describe("catalog", () => {
    it("returns all addon definitions with pricing", async () => {
      const caller = appRouter.createCaller(authedCtx("t-addons"));
      const result = await caller.addons.catalog();

      expect(result).toHaveLength(ADDON_KEYS.length);
      for (const item of result) {
        expect(item).toHaveProperty("key");
        expect(item).toHaveProperty("label");
        expect(item).toHaveProperty("dailyCostCents");
        expect(item).toHaveProperty("description");
        expect(typeof item.dailyCostCents).toBe("number");
      }
    });
  });

  describe("list", () => {
    it("returns empty array when no addons enabled", async () => {
      const caller = appRouter.createCaller(authedCtx("t-addons"));
      const result = await caller.addons.list();
      expect(result).toEqual([]);
    });

    it("returns enabled addons for the tenant", async () => {
      const caller = appRouter.createCaller(authedCtx("t-addons"));
      await caller.addons.enable({ key: "gpu_acceleration" });

      const result = await caller.addons.list();
      expect(result).toHaveLength(1);
      expect(result[0].key).toBe("gpu_acceleration");
      expect(result[0].label).toBe("GPU Acceleration");
      expect(typeof result[0].dailyCostCents).toBe("number");
      expect(result[0].enabledAt).toBeInstanceOf(Date);
    });

    it("scopes addons to the authenticated tenant only", async () => {
      const callerA = appRouter.createCaller(authedCtx("t-a"));
      const callerB = appRouter.createCaller(authedCtx("t-b"));

      await callerA.addons.enable({ key: "gpu_acceleration" });

      const resultB = await callerB.addons.list();
      expect(resultB).toEqual([]);
    });
  });

  describe("enable", () => {
    it("enables an addon and returns confirmation", async () => {
      const caller = appRouter.createCaller(authedCtx("t-addons"));
      const result = await caller.addons.enable({ key: "priority_queue" });

      expect(result).toEqual({ enabled: true, key: "priority_queue" });
    });

    it("is idempotent — enabling twice does not throw", async () => {
      const caller = appRouter.createCaller(authedCtx("t-addons"));
      await caller.addons.enable({ key: "extra_storage" });
      const result = await caller.addons.enable({ key: "extra_storage" });
      expect(result).toEqual({ enabled: true, key: "extra_storage" });
    });

    it("rejects invalid addon keys via zod validation", async () => {
      const caller = appRouter.createCaller(authedCtx("t-addons"));
      // @ts-expect-error — intentionally invalid key
      await expect(caller.addons.enable({ key: "nonexistent" })).rejects.toThrow();
    });
  });

  describe("disable", () => {
    it("disables an enabled addon", async () => {
      const caller = appRouter.createCaller(authedCtx("t-addons"));
      await caller.addons.enable({ key: "custom_domain" });
      const result = await caller.addons.disable({ key: "custom_domain" });

      expect(result).toEqual({ disabled: true, key: "custom_domain" });

      const list = await caller.addons.list();
      expect(list).toEqual([]);
    });

    it("disabling a non-enabled addon does not throw", async () => {
      const caller = appRouter.createCaller(authedCtx("t-addons"));
      const result = await caller.addons.disable({ key: "gpu_acceleration" });
      expect(result).toEqual({ disabled: true, key: "gpu_acceleration" });
    });
  });

  describe("auth guard", () => {
    it("rejects unauthenticated calls with UNAUTHORIZED", async () => {
      const caller = appRouter.createCaller(unauthCtx() as any);
      await expect(caller.addons.catalog()).rejects.toThrow(TRPCError);
      await expect(caller.addons.catalog()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    });
  });

  describe("tenant resolution fallback", () => {
    it("falls back to user.id when tenantId is undefined", async () => {
      const ctx = { user: { id: "user-fallback", roles: ["user"] }, tenantId: undefined };
      const caller = appRouter.createCaller(ctx);
      await caller.addons.enable({ key: "extra_storage" });
      const result = await caller.addons.list();
      expect(result).toHaveLength(1);
      expect(result[0].key).toBe("extra_storage");
    });
  });
});
