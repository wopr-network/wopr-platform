import { describe, expect, it } from "vitest";
import { extractTenantSubdomain } from "../../../src/api/routes/tenant-proxy.js";

describe("extractTenantSubdomain", () => {
  it("returns the subdomain for a valid tenant host", () => {
    expect(extractTenantSubdomain("alice.wopr.bot")).toBe("alice");
  });

  it("returns null for the root domain", () => {
    expect(extractTenantSubdomain("wopr.bot")).toBeNull();
  });

  it("returns null for the reserved app subdomain", () => {
    expect(extractTenantSubdomain("app.wopr.bot")).toBeNull();
  });

  it("returns null for the reserved api subdomain", () => {
    expect(extractTenantSubdomain("api.wopr.bot")).toBeNull();
  });

  it("is case-insensitive", () => {
    expect(extractTenantSubdomain("ALICE.WOPR.BOT")).toBe("alice");
  });

  it("strips port before extracting subdomain", () => {
    expect(extractTenantSubdomain("alice.wopr.bot:443")).toBe("alice");
  });

  it("returns null for a different domain", () => {
    expect(extractTenantSubdomain("evil.example.com")).toBeNull();
  });

  it("returns null for sub-sub-domains", () => {
    expect(extractTenantSubdomain("a.b.wopr.bot")).toBeNull();
  });

  it("returns null for an invalid DNS label starting with a hyphen", () => {
    expect(extractTenantSubdomain("-invalid.wopr.bot")).toBeNull();
  });

  it("returns null for the staging subdomain", () => {
    expect(extractTenantSubdomain("staging.wopr.bot")).toBeNull();
  });

  it("returns null for the www subdomain", () => {
    expect(extractTenantSubdomain("www.wopr.bot")).toBeNull();
  });

  it("handles hyphenated tenant names", () => {
    expect(extractTenantSubdomain("my-bot.wopr.bot")).toBe("my-bot");
  });
});
