import type { PGlite } from "@electric-sql/pglite";
import type { DrizzleDb } from "@wopr-network/platform-core/db/index";
import { DrizzleBillingEmailRepository } from "@wopr-network/platform-core/email";
import { createTestDb } from "@wopr-network/platform-core/test/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

describe("DrizzleBillingEmailRepository", () => {
  let db: DrizzleDb;
  let pool: PGlite;
  let repo: DrizzleBillingEmailRepository;

  beforeAll(async () => {
    const result = await createTestDb();
    db = result.db;
    pool = result.pool;
    repo = new DrizzleBillingEmailRepository(db);
  });

  afterAll(async () => {
    await pool.close();
  });

  it("shouldSend returns true when no email sent today", async () => {
    const result = await repo.shouldSend("tenant-email-1", "low-balance");
    expect(result).toBe(true);
  });

  it("recordSent inserts a dedup record", async () => {
    await repo.recordSent("tenant-email-1", "low-balance");
    const result = await repo.shouldSend("tenant-email-1", "low-balance");
    expect(result).toBe(false);
  });

  it("shouldSend returns true for different email type same tenant", async () => {
    const result = await repo.shouldSend("tenant-email-1", "bot-suspended");
    expect(result).toBe(true);
  });

  it("shouldSend returns true for same email type different tenant", async () => {
    const result = await repo.shouldSend("tenant-email-2", "low-balance");
    expect(result).toBe(true);
  });

  it("recordSent for different tenant does not affect dedup", async () => {
    await repo.recordSent("tenant-email-3", "low-balance");
    const result = await repo.shouldSend("tenant-email-3", "low-balance");
    expect(result).toBe(false);
    // original tenant-email-1 dedup still holds
    const result2 = await repo.shouldSend("tenant-email-1", "low-balance");
    expect(result2).toBe(false);
  });
});
