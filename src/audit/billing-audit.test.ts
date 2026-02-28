import { describe, expect, it } from "vitest";
import type { AuditAction, ResourceType } from "./schema.js";

describe("billing audit types", () => {
  it("accepts billing.auto_topup_update as a valid AuditAction", () => {
    const action: AuditAction = "billing.auto_topup_update";
    expect(action).toBe("billing.auto_topup_update");
  });

  it("accepts billing as a valid ResourceType", () => {
    const rt: ResourceType = "billing";
    expect(rt).toBe("billing");
  });
});
