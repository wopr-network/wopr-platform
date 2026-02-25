import { describe, expect, it } from "vitest";
import { canManageBot } from "./bot-authorization.js";

describe("canManageBot", () => {
  it("tenant_admin can manage any bot in their tenant", () => {
    expect(canManageBot("tenant_admin", "admin-1", "other-user")).toBe(true);
  });

  it("tenant_admin can manage legacy bots (null creator)", () => {
    expect(canManageBot("tenant_admin", "admin-1", null)).toBe(true);
  });

  it("platform_admin can manage any bot", () => {
    expect(canManageBot("platform_admin", "pa-1", "some-user")).toBe(true);
  });

  it("user can manage their own bot", () => {
    expect(canManageBot("user", "user-1", "user-1")).toBe(true);
  });

  it("user cannot manage another user's bot", () => {
    expect(canManageBot("user", "user-1", "user-2")).toBe(false);
  });

  it("user cannot manage legacy bot (null creator)", () => {
    expect(canManageBot("user", "user-1", null)).toBe(false);
  });

  it("null role (no role assigned) cannot manage any bot", () => {
    expect(canManageBot(null, "user-1", "user-1")).toBe(false);
  });
});
