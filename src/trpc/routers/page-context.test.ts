import { describe, expect, it } from "vitest";
import { getPageContext, pageContextRouter, updatePageContext } from "./page-context.js";

describe("pageContextRouter", () => {
  it("exports a valid tRPC router", () => {
    expect(pageContextRouter).toBeDefined();
  });

  it("stores and retrieves page context for a user", () => {
    const userId = "test-user-1";
    const ctx = { currentPage: "/dashboard", pagePrompt: "You are on the dashboard." };

    updatePageContext(userId, ctx);

    const result = getPageContext(userId);
    expect(result).toEqual(ctx);
  });

  it("returns null for unknown user", () => {
    const result = getPageContext("nonexistent-user");
    expect(result).toBeNull();
  });

  it("overwrites previous context on update", () => {
    const userId = "test-user-2";

    updatePageContext(userId, { currentPage: "/dashboard", pagePrompt: "Dashboard" });
    updatePageContext(userId, { currentPage: "/marketplace", pagePrompt: "Marketplace" });

    const result = getPageContext(userId);
    expect(result?.currentPage).toBe("/marketplace");
  });

  it("stores null pagePrompt", () => {
    const userId = "test-user-3";
    updatePageContext(userId, { currentPage: "/unknown", pagePrompt: null });

    const result = getPageContext(userId);
    expect(result?.pagePrompt).toBeNull();
    expect(result?.currentPage).toBe("/unknown");
  });
});
