import { describe, expect, it } from "vitest";
import { nodeAgentConfigSchema } from "./types.js";

describe("nodeAgentConfigSchema", () => {
  const validBase = { nodeSecret: "test-secret", nodeId: "node-1" };

  it("accepts https:// platformUrl", () => {
    const result = nodeAgentConfigSchema.safeParse({ ...validBase, platformUrl: "https://api.wopr.bot" });
    expect(result.success).toBe(true);
  });

  it("rejects http:// platformUrl", () => {
    const result = nodeAgentConfigSchema.safeParse({ ...validBase, platformUrl: "http://api.wopr.bot" });
    expect(result.success).toBe(false);
  });

  it("allows http:// for localhost (development)", () => {
    const result = nodeAgentConfigSchema.safeParse({ ...validBase, platformUrl: "http://localhost:3100" });
    expect(result.success).toBe(true);
  });

  it("allows http:// for 127.0.0.1 (development)", () => {
    const result = nodeAgentConfigSchema.safeParse({ ...validBase, platformUrl: "http://127.0.0.1:3100" });
    expect(result.success).toBe(true);
  });
});
