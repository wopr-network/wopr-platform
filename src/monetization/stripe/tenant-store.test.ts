import BetterSqlite3 from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import type { DrizzleDb } from "../../db/index.js";
import { createDb } from "../../db/index.js";
import { initStripeSchema } from "./schema.js";
import { TenantCustomerStore } from "./tenant-store.js";

describe("TenantCustomerStore", () => {
  let sqlite: BetterSqlite3.Database;
  let db: DrizzleDb;
  let store: TenantCustomerStore;

  beforeEach(() => {
    sqlite = new BetterSqlite3(":memory:");
    initStripeSchema(sqlite);
    db = createDb(sqlite);
    store = new TenantCustomerStore(db);
  });

  describe("upsert and getByTenant", () => {
    it("inserts a new tenant mapping", () => {
      store.upsert({ tenant: "t-1", stripeCustomerId: "cus_abc" });
      const row = store.getByTenant("t-1");

      expect(row).not.toBeNull();
      expect(row!.tenant).toBe("t-1");
      expect(row!.stripe_customer_id).toBe("cus_abc");
      expect(row!.tier).toBe("free");
    });

    it("updates existing mapping on conflict", () => {
      store.upsert({ tenant: "t-1", stripeCustomerId: "cus_old" });
      store.upsert({ tenant: "t-1", stripeCustomerId: "cus_new" });

      const row = store.getByTenant("t-1");
      expect(row!.stripe_customer_id).toBe("cus_new");
    });

    it("returns null for non-existent tenant", () => {
      expect(store.getByTenant("nonexistent")).toBeNull();
    });
  });

  describe("getByStripeCustomerId", () => {
    it("looks up by Stripe customer ID", () => {
      store.upsert({ tenant: "t-1", stripeCustomerId: "cus_lookup" });
      const row = store.getByStripeCustomerId("cus_lookup");

      expect(row).not.toBeNull();
      expect(row!.tenant).toBe("t-1");
    });

    it("returns null for unknown Stripe customer", () => {
      expect(store.getByStripeCustomerId("cus_unknown")).toBeNull();
    });
  });

  describe("setTier", () => {
    it("updates the tier for a tenant", () => {
      store.upsert({ tenant: "t-1", stripeCustomerId: "cus_abc" });
      store.setTier("t-1", "enterprise");

      const row = store.getByTenant("t-1");
      expect(row!.tier).toBe("enterprise");
    });
  });

  describe("setBillingHold and hasBillingHold", () => {
    it("sets and checks billing hold", () => {
      store.upsert({ tenant: "t-1", stripeCustomerId: "cus_abc" });

      expect(store.hasBillingHold("t-1")).toBe(false);

      store.setBillingHold("t-1", true);
      expect(store.hasBillingHold("t-1")).toBe(true);

      store.setBillingHold("t-1", false);
      expect(store.hasBillingHold("t-1")).toBe(false);
    });

    it("returns false for non-existent tenant", () => {
      expect(store.hasBillingHold("nonexistent")).toBe(false);
    });
  });

  describe("list", () => {
    it("returns all tenant mappings", () => {
      store.upsert({ tenant: "t-1", stripeCustomerId: "cus_1" });
      store.upsert({ tenant: "t-2", stripeCustomerId: "cus_2" });
      store.upsert({ tenant: "t-3", stripeCustomerId: "cus_3" });

      const rows = store.list();
      expect(rows).toHaveLength(3);
    });

    it("returns empty array when no tenants exist", () => {
      expect(store.list()).toHaveLength(0);
    });
  });

  describe("buildCustomerIdMap", () => {
    it("builds a tenant->stripeCustomerId map", () => {
      store.upsert({ tenant: "t-1", stripeCustomerId: "cus_1" });
      store.upsert({ tenant: "t-2", stripeCustomerId: "cus_2" });

      const map = store.buildCustomerIdMap();
      expect(map).toEqual({
        "t-1": "cus_1",
        "t-2": "cus_2",
      });
    });

    it("returns empty object when no tenants exist", () => {
      expect(store.buildCustomerIdMap()).toEqual({});
    });
  });
});
