import { describe, expect, it } from "vitest";
import { recoveryItems } from "./recovery-events.js";

describe("recovery_items schema", () => {
  it("has retryCount column", () => {
    const cols = Object.keys(recoveryItems);
    expect(cols).toContain("retryCount");
  });
});
