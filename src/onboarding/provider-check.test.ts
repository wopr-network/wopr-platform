import { describe, expect, it, vi } from "vitest";
import { checkProviderConfigured } from "./provider-check.js";

function makeKeyLookup(row?: { provider: string }) {
  return {
    findFirstByTenantId: vi.fn().mockResolvedValue(row),
  };
}

describe("checkProviderConfigured", () => {
  it("returns configured:true when tenant has a BYOK key", async () => {
    const keyLookup = makeKeyLookup({ provider: "anthropic" });

    const result = await checkProviderConfigured(keyLookup, "tenant-1");
    expect(result).toEqual({ configured: true, provider: "anthropic" });
  });

  it("returns configured:false when tenant has no keys", async () => {
    const keyLookup = makeKeyLookup(undefined);

    const result = await checkProviderConfigured(keyLookup, "tenant-1");
    expect(result).toEqual({ configured: false });
  });

  it("returns configured:true for wopr-hosted when setup collected has provider", async () => {
    const keyLookup = makeKeyLookup(undefined);
    const setupRepo = {
      findBySessionId: vi.fn().mockResolvedValue({
        id: "setup-1",
        collected: JSON.stringify({ provider: "wopr-hosted" }),
      }),
    };

    const result = await checkProviderConfigured(keyLookup, "tenant-1", {
      setupRepo,
      sessionId: "session-1",
    });
    expect(result).toEqual({ configured: true, provider: "wopr-hosted" });
  });

  it("returns configured:false when setup session has no collected data", async () => {
    const keyLookup = makeKeyLookup(undefined);
    const setupRepo = {
      findBySessionId: vi.fn().mockResolvedValue(null),
    };

    const result = await checkProviderConfigured(keyLookup, "tenant-1", {
      setupRepo,
      sessionId: "session-1",
    });
    expect(result).toEqual({ configured: false });
  });

  it("returns configured:false when collected JSON is invalid", async () => {
    const keyLookup = makeKeyLookup(undefined);
    const setupRepo = {
      findBySessionId: vi.fn().mockResolvedValue({
        id: "setup-1",
        collected: "not-valid-json{{{",
      }),
    };

    const result = await checkProviderConfigured(keyLookup, "tenant-1", {
      setupRepo,
      sessionId: "session-1",
    });
    expect(result).toEqual({ configured: false });
  });
});
