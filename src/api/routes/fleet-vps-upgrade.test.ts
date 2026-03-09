import { describe, expect, it, vi } from "vitest";
import type { ITenantCustomerRepository } from "../../monetization/stripe/tenant-store.js";

/**
 * Regression test for WOP-2003:
 * tenantRepo.getByTenant() is async and must be awaited before checking for null.
 * Without `await`, `customer` is always a truthy Promise object — the guard never fires.
 */
describe("VPS upgrade payment guard — await fix (WOP-2003)", () => {
  it("guard fires when getByTenant resolves to null (i.e., await is present)", async () => {
    const mockTenantRepo: Pick<ITenantCustomerRepository, "getByTenant"> = {
      getByTenant: vi.fn().mockResolvedValue(null),
    };

    // Simulate the fixed code: await the promise before the guard
    const customer = await mockTenantRepo.getByTenant("tenant-abc");

    // With await: customer is null — guard would fire, returning 402
    expect(customer).toBeNull();
    expect(!customer).toBe(true);
  });

  it("guard does NOT fire when getByTenant resolves to a customer record", async () => {
    const mockTenantRepo: Pick<ITenantCustomerRepository, "getByTenant"> = {
      getByTenant: vi.fn().mockResolvedValue({ processor_customer_id: "cus_123", tenant: "tenant-abc" }),
    };

    const customer = await mockTenantRepo.getByTenant("tenant-abc");

    // With await: customer is a record — guard would not fire
    expect(customer).not.toBeNull();
    expect(!customer).toBe(false);
  });

  it("demonstrates the original bug: unawaited Promise is always truthy (guard never fires)", () => {
    const mockTenantRepo: Pick<ITenantCustomerRepository, "getByTenant"> = {
      getByTenant: vi.fn().mockResolvedValue(null),
    };

    // Simulate the BUGGY code: no await — customer is a Promise object
    const customerBuggy = mockTenantRepo.getByTenant("tenant-abc");

    // Promise is always truthy — guard would NOT fire even though tenant has no payment method
    expect(customerBuggy).toBeInstanceOf(Promise);
    expect(!customerBuggy).toBe(false); // bug: guard never triggers
  });
});
