import { describe, expect, it } from "vitest";

describe("repository-types imports", () => {
  it("imports auth repository types", async () => {
    const mod = await import("../auth/repository-types.js");
    expect(mod).toBeDefined();
  });

  it("imports api repository types", async () => {
    const mod = await import("../api/repository-types.js");
    expect(mod).toBeDefined();
  });

  it("imports gateway repository types", async () => {
    const mod = await import("../gateway/repository-types.js");
    expect(mod).toBeDefined();
  });

  it("imports observability repository types", async () => {
    const mod = await import("../observability/repository-types.js");
    expect(mod).toBeDefined();
  });
});
