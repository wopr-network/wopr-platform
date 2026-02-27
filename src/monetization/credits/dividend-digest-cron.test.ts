import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DrizzleDb } from "../../db/index.js";
import { adminUsers } from "../../db/schema/admin-users.js";
import { dividendDistributions } from "../../db/schema/dividend-distributions.js";
import type { NotificationService } from "../../email/notification-service.js";
import { createTestDb } from "../../test/db.js";
import { Credit } from "../credit.js";
import { type DividendDigestConfig, runDividendDigestCron } from "./dividend-digest-cron.js";
import { DrizzleDividendRepository } from "./dividend-repository.js";

async function insertDistribution(
  db: DrizzleDb,
  tenantId: string,
  date: string,
  amountCents: number,
  poolCents: number,
  activeUsers: number,
): Promise<void> {
  const id = `dist-${tenantId}-${date}-${Math.random()}`;
  await db.insert(dividendDistributions).values({ id, tenantId, date, amountCents, poolCents, activeUsers });
}

async function insertUser(db: DrizzleDb, tenantId: string, email: string): Promise<void> {
  await db.insert(adminUsers).values({
    id: `user-${tenantId}`,
    email,
    tenantId,
    createdAt: Date.now(),
  });
}

describe("runDividendDigestCron", () => {
  let pool: PGlite;
  let db: DrizzleDb;
  let mockNotificationService: NotificationService;
  let enqueuedCalls: Array<{ tenantId: string; email: string; weeklyTotalDollars: string }>;

  beforeEach(async () => {
    ({ db, pool } = await createTestDb());
    enqueuedCalls = [];
    mockNotificationService = {
      notifyDividendWeeklyDigest: vi.fn((tenantId: string, email: string, weeklyTotalDollars: string) => {
        enqueuedCalls.push({ tenantId, email, weeklyTotalDollars });
      }),
    } as unknown as NotificationService;
  });

  afterEach(async () => {
    await pool.close();
  });

  function makeConfig(overrides?: Partial<DividendDigestConfig>): DividendDigestConfig {
    return {
      dividendRepo: new DrizzleDividendRepository(db),
      notificationService: mockNotificationService,
      appBaseUrl: "https://app.wopr.bot",
      digestDate: "2026-02-23",
      ...overrides,
    };
  }

  it("returns zero when no distributions exist", async () => {
    const result = await runDividendDigestCron(makeConfig());
    expect(result.qualified).toBe(0);
    expect(result.enqueued).toBe(0);
  });

  it("sends digest to users with distributions in the past 7 days", async () => {
    await insertUser(db, "t1", "alice@example.com");
    await insertDistribution(db, "t1", "2026-02-17", 100, 1000, 10);
    await insertDistribution(db, "t1", "2026-02-19", 200, 2000, 12);

    const result = await runDividendDigestCron(makeConfig());
    expect(result.qualified).toBe(1);
    expect(result.enqueued).toBe(1);
    expect(enqueuedCalls[0].tenantId).toBe("t1");
    expect(enqueuedCalls[0].email).toBe("alice@example.com");
    expect(enqueuedCalls[0].weeklyTotalDollars).toBe("$3.00");
  });

  it("skips tenants below minimum threshold", async () => {
    await insertUser(db, "t1", "alice@example.com");
    await insertDistribution(db, "t1", "2026-02-20", 1, 100, 10);

    const result = await runDividendDigestCron(makeConfig({ minTotal: Credit.fromCents(2) }));
    expect(result.qualified).toBe(0);
    expect(result.enqueued).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it("skips tenants with no admin_users email", async () => {
    await insertDistribution(db, "t-orphan", "2026-02-20", 500, 5000, 10);

    const result = await runDividendDigestCron(makeConfig());
    expect(result.qualified).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it("handles multiple tenants", async () => {
    await insertUser(db, "t1", "alice@example.com");
    await insertUser(db, "t2", "bob@example.com");
    await insertDistribution(db, "t1", "2026-02-20", 500, 5000, 10);
    await insertDistribution(db, "t2", "2026-02-21", 300, 3000, 8);

    const result = await runDividendDigestCron(makeConfig());
    expect(result.qualified).toBe(2);
    expect(result.enqueued).toBe(2);
  });

  it("excludes distributions outside the 7-day window", async () => {
    await insertUser(db, "t1", "alice@example.com");
    await insertDistribution(db, "t1", "2026-02-10", 500, 5000, 10);

    const result = await runDividendDigestCron(makeConfig());
    expect(result.qualified).toBe(0);
  });
});
