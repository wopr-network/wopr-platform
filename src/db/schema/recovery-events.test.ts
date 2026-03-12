import { recoveryItems } from "@wopr-network/platform-core/db/schema/recovery-events";
import { describe, expect, it } from "vitest";

describe("recovery_items schema", () => {
  it("has retryCount column", () => {
    const cols = Object.keys(recoveryItems);
    expect(cols).toContain("retryCount");
  });
});
