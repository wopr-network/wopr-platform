import { beforeEach, describe, expect, it } from "vitest";
import type { TenantCustomerRepository } from "../../domain/repositories/tenant-customer-repository.js";
import { TenantId } from "../../domain/value-objects/tenant-id.js";
import { InMemoryTenantCustomerRepository } from "./in-memory-tenant-customer-repository.js";

describe("TenantCustomerRepository Contract", () => {
  runRepositoryContractTests("InMemoryTenantCustomerRepository", async () => {
    return new InMemoryTenantCustomerRepository();
  });
});

function runRepositoryContractTests(
  name: string,
  createRepo: () => Promise<TenantCustomerRepository> | TenantCustomerRepository,
) {
  describe(name, () => {
    let repo: TenantCustomerRepository;
    let tenantId: TenantId;

    beforeEach(async () => {
      repo = await createRepo();
      tenantId = TenantId.create("test-tenant-1");
    });

    describe("upsert", () => {
      it("should create a new tenant customer mapping", async () => {
        await repo.upsert(tenantId, "cus_123", "pro");

        const customer = await repo.getByTenant(tenantId);
        expect(customer).not.toBeNull();
        expect(customer?.stripeCustomerId).toBe("cus_123");
        expect(customer?.tier).toBe("pro");
        expect(customer?.billingHold).toBe(false);
      });

      it("should update existing mapping on upsert", async () => {
        await repo.upsert(tenantId, "cus_123", "free");
        await repo.upsert(tenantId, "cus_456", "pro");

        const customer = await repo.getByTenant(tenantId);
        expect(customer?.stripeCustomerId).toBe("cus_456");
        expect(customer?.tier).toBe("pro");
      });
    });

    describe("getByTenant", () => {
      it("should return null for non-existent tenant", async () => {
        const customer = await repo.getByTenant(TenantId.create("non-existent"));
        expect(customer).toBeNull();
      });

      it("should return customer for existing tenant", async () => {
        await repo.upsert(tenantId, "cus_123");

        const customer = await repo.getByTenant(tenantId);
        expect(customer).not.toBeNull();
        expect(customer?.stripeCustomerId).toBe("cus_123");
      });
    });

    describe("getByStripeCustomerId", () => {
      it("should return null for non-existent stripe customer", async () => {
        const customer = await repo.getByStripeCustomerId("cus_non_existent");
        expect(customer).toBeNull();
      });

      it("should return customer for existing stripe customer", async () => {
        await repo.upsert(tenantId, "cus_123");

        const customer = await repo.getByStripeCustomerId("cus_123");
        expect(customer).not.toBeNull();
        expect(customer?.tenantId.equals(tenantId)).toBe(true);
      });
    });

    describe("setTier", () => {
      it("should update the tier for a tenant", async () => {
        await repo.upsert(tenantId, "cus_123", "free");
        await repo.setTier(tenantId, "pro");

        const customer = await repo.getByTenant(tenantId);
        expect(customer?.tier).toBe("pro");
      });
    });

    describe("setBillingHold", () => {
      it("should set billing hold", async () => {
        await repo.upsert(tenantId, "cus_123");
        await repo.setBillingHold(tenantId, true);

        const customer = await repo.getByTenant(tenantId);
        expect(customer?.billingHold).toBe(true);
      });

      it("should clear billing hold", async () => {
        await repo.upsert(tenantId, "cus_123");
        await repo.setBillingHold(tenantId, true);
        await repo.setBillingHold(tenantId, false);

        const customer = await repo.getByTenant(tenantId);
        expect(customer?.billingHold).toBe(false);
      });
    });

    describe("hasBillingHold", () => {
      it("should return false when no billing hold", async () => {
        await repo.upsert(tenantId, "cus_123");

        const hasHold = await repo.hasBillingHold(tenantId);
        expect(hasHold).toBe(false);
      });

      it("should return true when billing hold is set", async () => {
        await repo.upsert(tenantId, "cus_123");
        await repo.setBillingHold(tenantId, true);

        const hasHold = await repo.hasBillingHold(tenantId);
        expect(hasHold).toBe(true);
      });

      it("should return false for non-existent tenant", async () => {
        const hasHold = await repo.hasBillingHold(TenantId.create("non-existent"));
        expect(hasHold).toBe(false);
      });
    });

    describe("list", () => {
      it("should return empty list when no customers", async () => {
        const customers = await repo.list();
        expect(customers).toHaveLength(0);
      });

      it("should return all customers sorted by createdAt desc", async () => {
        const tenant2 = TenantId.create("tenant-2");
        const tenant3 = TenantId.create("tenant-3");

        await repo.upsert(tenantId, "cus_1", "free");
        await new Promise((r) => setTimeout(r, 10)); // Ensure different timestamps
        await repo.upsert(tenant2, "cus_2", "pro");
        await new Promise((r) => setTimeout(r, 10));
        await repo.upsert(tenant3, "cus_3", "enterprise");

        const customers = await repo.list();
        expect(customers).toHaveLength(3);
        // First should be tenant-3 (most recent), last should be test-tenant-1 (oldest)
        expect(customers[0].tenantId.toString()).toBe("tenant-3");
        expect(customers[customers.length - 1].tenantId.toString()).toBe("test-tenant-1");
      });
    });

    describe("buildCustomerIdMap", () => {
      it("should return empty map when no customers", async () => {
        const map = await repo.buildCustomerIdMap();
        expect(Object.keys(map)).toHaveLength(0);
      });

      it("should return tenant -> stripe customer map", async () => {
        await repo.upsert(tenantId, "cus_123");
        await repo.upsert(TenantId.create("tenant-2"), "cus_456");

        const map = await repo.buildCustomerIdMap();
        expect(map["test-tenant-1"]).toBe("cus_123");
        expect(map["tenant-2"]).toBe("cus_456");
      });
    });
  });
}
