import { describe, expect, it } from "vitest";

describe("repository-types imports", () => {
  it("imports api repository types", async () => {
    const mod = await import("../api/repository-types.js");
    // Type-only exports (OAuthState, SigPenalty, RateLimitEntry) are erased at runtime.
    // This test verifies the module is valid TypeScript and importable.
    expect(typeof mod).toBe("object");
  });

  it("imports gateway repository types", async () => {
    const mod = await import("../gateway/repository-types.js");
    expect(typeof mod).toBe("object");
  });

  it("imports observability repository types", async () => {
    const mod = await import("../observability/repository-types.js");
    expect(typeof mod).toBe("object");
  });
});
