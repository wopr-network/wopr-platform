import { beforeEach, describe, expect, it } from "vitest";
import type { ITenantModelSelectionRepository } from "../../db/tenant-model-selection-repository.js";
import { appRouter } from "../index.js";
import type { TRPCContext } from "../init.js";
import { setModelSelectionRouterDeps } from "./model-selection.js";

function tenantContext(overrides: Partial<TRPCContext> = {}): TRPCContext {
  return {
    user: { id: "test-user", roles: [] },
    tenantId: "test-tenant",
    ...overrides,
  };
}

function unauthContext(): TRPCContext {
  return { user: undefined, tenantId: undefined };
}

function createCaller(ctx: TRPCContext) {
  return appRouter.createCaller(ctx);
}

function makeInMemoryRepo(): ITenantModelSelectionRepository {
  const store = new Map<string, string>();
  return {
    getDefaultModel(tenantId: string): string {
      return store.get(tenantId) ?? "openrouter/auto";
    },
    setDefaultModel(tenantId: string, defaultModel: string): void {
      store.set(tenantId, defaultModel);
    },
  };
}

describe("tRPC model selection router", () => {
  beforeEach(() => {
    const repo = makeInMemoryRepo();
    setModelSelectionRouterDeps({ getRepository: () => repo });
  });

  describe("getDefaultModel", () => {
    it("returns default when no row exists", async () => {
      const caller = createCaller(tenantContext());
      const result = await caller.modelSelection.getDefaultModel();
      expect(result.defaultModel).toBe("openrouter/auto");
    });

    it("rejects unauthenticated", async () => {
      const caller = createCaller(unauthContext());
      await expect(caller.modelSelection.getDefaultModel()).rejects.toThrow("Authentication required");
    });

    it("rejects missing tenant", async () => {
      const caller = createCaller({ user: { id: "u", roles: [] }, tenantId: undefined });
      await expect(caller.modelSelection.getDefaultModel()).rejects.toThrow("Tenant context required");
    });
  });

  describe("setDefaultModel", () => {
    it("sets and returns the model", async () => {
      const caller = createCaller(tenantContext());
      const result = await caller.modelSelection.setDefaultModel({ defaultModel: "anthropic/claude-3.5-sonnet" });
      expect(result.defaultModel).toBe("anthropic/claude-3.5-sonnet");

      const fetched = await caller.modelSelection.getDefaultModel();
      expect(fetched.defaultModel).toBe("anthropic/claude-3.5-sonnet");
    });

    it("rejects empty model string", async () => {
      const caller = createCaller(tenantContext());
      await expect(caller.modelSelection.setDefaultModel({ defaultModel: "" })).rejects.toThrow();
    });
  });
});
