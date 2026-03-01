/**
 * tRPC usage router tests — WOP-1183
 */

import { TRPCError } from "@trpc/server";
import { describe, expect, it } from "vitest";
import { usageRouter } from "./usage.js";

function authedCtx(userId = "user-1") {
  return {
    user: { id: userId, roles: ["user"] },
    tenantId: "t-usage",
  };
}

function unauthCtx() {
  return { user: undefined as undefined, tenantId: undefined as string | undefined };
}

describe("usage router", () => {
  describe("quota", () => {
    it("returns allowed=true with unlimited instances by default", async () => {
      const caller = usageRouter.createCaller(authedCtx());
      const result = await caller.quota({ activeInstances: 0 });

      expect(result.allowed).toBe(true);
      expect(result.currentInstances).toBe(0);
      expect(result.maxInstances).toBe(0); // 0 = unlimited
    });

    it("returns allowed=true even with many active instances (unlimited plan)", async () => {
      const caller = usageRouter.createCaller(authedCtx());
      const result = await caller.quota({ activeInstances: 100 });

      expect(result.allowed).toBe(true);
      expect(result.currentInstances).toBe(100);
    });

    it("defaults activeInstances to 0 when not provided", async () => {
      const caller = usageRouter.createCaller(authedCtx());
      const result = await caller.quota({});

      expect(result.allowed).toBe(true);
      expect(result.currentInstances).toBe(0);
    });

    it("rejects negative activeInstances", async () => {
      const caller = usageRouter.createCaller(authedCtx());
      await expect(caller.quota({ activeInstances: -1 })).rejects.toThrow();
    });
  });

  describe("quotaCheck", () => {
    it("returns full quota check result", async () => {
      const caller = usageRouter.createCaller(authedCtx());
      const result = await caller.quotaCheck({ activeInstances: 5 });

      expect(result).toHaveProperty("allowed");
      expect(result).toHaveProperty("currentInstances", 5);
      expect(result).toHaveProperty("maxInstances");
      expect(result).toHaveProperty("inGracePeriod");
    });

    it("defaults softCap to false", async () => {
      const caller = usageRouter.createCaller(authedCtx());
      const result = await caller.quotaCheck({ activeInstances: 0 });

      expect(result.inGracePeriod).toBe(false);
    });
  });

  describe("resourceLimits", () => {
    it("returns Docker resource constraints", async () => {
      const caller = usageRouter.createCaller(authedCtx());
      const result = await caller.resourceLimits();

      expect(result).toHaveProperty("Memory");
      expect(result).toHaveProperty("CpuQuota");
      expect(result).toHaveProperty("PidsLimit");
      expect(result.Memory).toBe(2048 * 1024 * 1024); // 2GB in bytes
      expect(result.CpuQuota).toBe(200_000);
      expect(result.PidsLimit).toBe(512);
    });
  });

  describe("auth guard", () => {
    it("rejects unauthenticated quota call with UNAUTHORIZED", async () => {
      const caller = usageRouter.createCaller(unauthCtx() as any);
      await expect(caller.quota({ activeInstances: 0 })).rejects.toThrow(TRPCError);
      await expect(caller.quota({ activeInstances: 0 })).rejects.toMatchObject({
        code: "UNAUTHORIZED",
      });
    });

    it("rejects unauthenticated resourceLimits call", async () => {
      const caller = usageRouter.createCaller(unauthCtx() as any);
      await expect(caller.resourceLimits()).rejects.toMatchObject({
        code: "UNAUTHORIZED",
      });
    });
  });
});
