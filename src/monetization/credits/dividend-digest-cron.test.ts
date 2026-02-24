import BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type DrizzleDb } from "../../db/index.js";
import type { NotificationService } from "../../email/notification-service.js";
import { type DividendDigestConfig, runDividendDigestCron } from "./dividend-digest-cron.js";
import { DrizzleDividendRepository } from "./dividend-repository.js";

function initTestSchema(sqlite: BetterSqlite3.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS dividend_distributions (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      date TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      pool_cents INTEGER NOT NULL,
      active_users INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS admin_users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      name TEXT,
      tenant_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      role TEXT NOT NULL DEFAULT 'user',
      credit_balance_cents INTEGER NOT NULL DEFAULT 0,
      agent_count INTEGER NOT NULL DEFAULT 0,
      last_seen INTEGER,
      created_at INTEGER NOT NULL
    )
  `);
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS credit_transactions (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      type TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      balance_cents INTEGER NOT NULL,
      description TEXT NOT NULL,
      reference_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}

function insertDistribution(
  sqlite: BetterSqlite3.Database,
  tenantId: string,
  date: string,
  amountCents: number,
  poolCents: number,
  activeUsers: number,
): void {
  const id = `dist-${tenantId}-${date}-${Math.random()}`;
  sqlite
    .prepare(
      "INSERT INTO dividend_distributions (id, tenant_id, date, amount_cents, pool_cents, active_users) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(id, tenantId, date, amountCents, poolCents, activeUsers);
}

function insertUser(sqlite: BetterSqlite3.Database, tenantId: string, email: string): void {
  sqlite
    .prepare("INSERT INTO admin_users (id, email, tenant_id, created_at) VALUES (?, ?, ?, ?)")
    .run(`user-${tenantId}`, email, tenantId, Date.now());
}

describe("runDividendDigestCron", () => {
  let sqlite: BetterSqlite3.Database;
  let db: DrizzleDb;
  let mockNotificationService: NotificationService;
  let enqueuedCalls: Array<{ tenantId: string; email: string; weeklyTotalDollars: string }>;

  beforeEach(() => {
    sqlite = new BetterSqlite3(":memory:");
    initTestSchema(sqlite);
    db = createDb(sqlite);
    enqueuedCalls = [];
    mockNotificationService = {
      notifyDividendWeeklyDigest: vi.fn((tenantId: string, email: string, weeklyTotalDollars: string) => {
        enqueuedCalls.push({ tenantId, email, weeklyTotalDollars });
      }),
    } as unknown as NotificationService;
  });

  afterEach(() => {
    sqlite.close();
  });

  function makeConfig(overrides?: Partial<DividendDigestConfig>): DividendDigestConfig {
    return {
      dividendRepo: new DrizzleDividendRepository(db),
      notificationService: mockNotificationService,
      appBaseUrl: "https://app.wopr.bot",
      digestDate: "2026-02-23", // a Monday
      ...overrides,
    };
  }

  it("returns zero when no distributions exist", async () => {
    const result = await runDividendDigestCron(makeConfig());
    expect(result.qualified).toBe(0);
    expect(result.enqueued).toBe(0);
  });

  it("sends digest to users with distributions in the past 7 days", async () => {
    insertUser(sqlite, "t1", "alice@example.com");
    insertDistribution(sqlite, "t1", "2026-02-17", 100, 1000, 10);
    insertDistribution(sqlite, "t1", "2026-02-19", 200, 2000, 12);

    const result = await runDividendDigestCron(makeConfig());
    expect(result.qualified).toBe(1);
    expect(result.enqueued).toBe(1);
    expect(enqueuedCalls[0].tenantId).toBe("t1");
    expect(enqueuedCalls[0].email).toBe("alice@example.com");
    expect(enqueuedCalls[0].weeklyTotalDollars).toBe("$3.00");
  });

  it("skips tenants below minimum threshold", async () => {
    insertUser(sqlite, "t1", "alice@example.com");
    insertDistribution(sqlite, "t1", "2026-02-20", 1, 100, 10); // 1 cent

    const result = await runDividendDigestCron(makeConfig({ minTotalCents: 2 }));
    expect(result.qualified).toBe(0);
    expect(result.enqueued).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it("skips tenants with no admin_users email", async () => {
    // Distribution exists but no admin_users row
    insertDistribution(sqlite, "t-orphan", "2026-02-20", 500, 5000, 10);

    const result = await runDividendDigestCron(makeConfig());
    expect(result.qualified).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it("handles multiple tenants", async () => {
    insertUser(sqlite, "t1", "alice@example.com");
    insertUser(sqlite, "t2", "bob@example.com");
    insertDistribution(sqlite, "t1", "2026-02-20", 500, 5000, 10);
    insertDistribution(sqlite, "t2", "2026-02-21", 300, 3000, 8);

    const result = await runDividendDigestCron(makeConfig());
    expect(result.qualified).toBe(2);
    expect(result.enqueued).toBe(2);
  });

  it("excludes distributions outside the 7-day window", async () => {
    insertUser(sqlite, "t1", "alice@example.com");
    insertDistribution(sqlite, "t1", "2026-02-10", 500, 5000, 10); // too old

    const result = await runDividendDigestCron(makeConfig());
    expect(result.qualified).toBe(0);
  });
});
