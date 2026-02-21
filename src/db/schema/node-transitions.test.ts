import { describe, expect, it } from "vitest";
import { nodeTransitions } from "./node-transitions.js";

describe("node_transitions schema", () => {
  it("has required columns", () => {
    const cols = Object.keys(nodeTransitions);
    expect(cols).toContain("id");
    expect(cols).toContain("nodeId");
    expect(cols).toContain("fromStatus");
    expect(cols).toContain("toStatus");
    expect(cols).toContain("reason");
    expect(cols).toContain("triggeredBy");
    expect(cols).toContain("createdAt");
  });
});
