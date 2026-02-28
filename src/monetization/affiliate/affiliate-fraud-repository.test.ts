import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DrizzleDb } from "../../db/index.js";
import { createTestDb } from "../../test/db.js";
import { DrizzleAffiliateFraudRepository } from "./affiliate-fraud-repository.js";

describe("DrizzleAffiliateFraudRepository", () => {
  let pool: PGlite;
  let db: DrizzleDb;
  let repo: DrizzleAffiliateFraudRepository;

  beforeEach(async () => {
    ({ db, pool } = await createTestDb());
    repo = new DrizzleAffiliateFraudRepository(db);
  });

  afterEach(async () => {
    await pool.close();
  });

  it("records a fraud event", async () => {
    await repo.record({
      referralId: "ref-1",
      referrerTenantId: "t-a",
      referredTenantId: "t-b",
      verdict: "flagged",
      signals: ["same_ip"],
      signalDetails: { same_ip: "Both used 1.2.3.4" },
      phase: "signup",
    });

    const events = await repo.listByReferrer("t-a");
    expect(events).toHaveLength(1);
    expect(events[0].verdict).toBe("flagged");
    expect(events[0].signals).toEqual(["same_ip"]);
  });

  it("is idempotent on referralId + phase", async () => {
    const input = {
      referralId: "ref-1",
      referrerTenantId: "t-a",
      referredTenantId: "t-b",
      verdict: "flagged" as const,
      signals: ["same_ip"],
      signalDetails: { same_ip: "Both used 1.2.3.4" },
      phase: "signup" as const,
    };
    await repo.record(input);
    await repo.record(input); // no-op

    const events = await repo.listByReferrer("t-a");
    expect(events).toHaveLength(1);
  });

  it("checks if a referral has a block verdict", async () => {
    await repo.record({
      referralId: "ref-1",
      referrerTenantId: "t-a",
      referredTenantId: "t-b",
      verdict: "blocked",
      signals: ["same_ip", "email_alias"],
      signalDetails: { same_ip: "1.2.3.4", email_alias: "same base" },
      phase: "payout",
    });

    expect(await repo.isBlocked("ref-1", "payout")).toBe(true);
    expect(await repo.isBlocked("ref-1", "signup")).toBe(false);
    expect(await repo.isBlocked("ref-999", "payout")).toBe(false);
  });
});
