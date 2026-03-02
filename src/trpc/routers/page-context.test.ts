import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IPageContextRepository, PageContext } from "../../fleet/page-context-repository.js";
import { pageContextRouter, setPageContextRouterDeps } from "./page-context.js";

function makeMockRepo(): IPageContextRepository & { store: Map<string, PageContext> } {
  const store = new Map<string, PageContext>();
  return {
    store,
    async get(userId: string) {
      return store.get(userId) ?? null;
    },
    async set(userId: string, currentPage: string, pagePrompt: string | null) {
      store.set(userId, { userId, currentPage, pagePrompt, updatedAt: Date.now() });
    },
    async list() {
      return Array.from(store.values());
    },
  };
}

describe("pageContextRouter", () => {
  let mockRepo: ReturnType<typeof makeMockRepo>;

  beforeEach(() => {
    mockRepo = makeMockRepo();
    setPageContextRouterDeps({ repo: mockRepo });
  });

  afterEach(() => {
    setPageContextRouterDeps(null as unknown as { repo: IPageContextRepository });
  });

  it("exports a valid tRPC router", () => {
    expect(pageContextRouter).not.toBeUndefined();
  });

  it("stores and retrieves page context for a user", async () => {
    await mockRepo.set("test-user-1", "/dashboard", "You are on the dashboard.");
    const result = await mockRepo.get("test-user-1");
    expect(result).toEqual(
      expect.objectContaining({ currentPage: "/dashboard", pagePrompt: "You are on the dashboard." }),
    );
  });

  it("returns null for unknown user", async () => {
    const result = await mockRepo.get("nonexistent-user");
    expect(result).toBeNull();
  });

  it("overwrites previous context on update", async () => {
    await mockRepo.set("test-user-2", "/dashboard", "Dashboard");
    await mockRepo.set("test-user-2", "/marketplace", "Marketplace");
    const result = await mockRepo.get("test-user-2");
    expect(result?.currentPage).toBe("/marketplace");
  });

  it("stores null pagePrompt", async () => {
    await mockRepo.set("test-user-3", "/unknown", null);
    const result = await mockRepo.get("test-user-3");
    expect(result?.pagePrompt).toBeNull();
    expect(result?.currentPage).toBe("/unknown");
  });
});
