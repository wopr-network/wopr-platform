import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { beforeEach, describe, expect, it } from "vitest";
import * as schema from "../../src/db/schema/index.js";
import { DrizzleOnboardingSessionRepository } from "../../src/onboarding/drizzle-onboarding-session-repository.js";

function createTestDb() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: "drizzle/migrations" });
  return db;
}

describe("DrizzleOnboardingSessionRepository", () => {
  let repo: DrizzleOnboardingSessionRepository;

  beforeEach(() => {
    repo = new DrizzleOnboardingSessionRepository(createTestDb());
  });

  it("creates and retrieves a session by id", () => {
    const session = repo.create({
      id: "s1",
      userId: "u1",
      anonymousId: null,
      woprSessionName: "onboarding-u1",
      status: "active",
    });
    expect(session.id).toBe("s1");
    expect(session.userId).toBe("u1");
    expect(session.budgetUsedCents).toBe(0);

    const found = repo.getById("s1");
    expect(found).not.toBeNull();
    expect(found!.woprSessionName).toBe("onboarding-u1");
  });

  it("retrieves by userId", () => {
    repo.create({ id: "s2", userId: "u2", anonymousId: null, woprSessionName: "onboarding-u2", status: "active" });
    const found = repo.getByUserId("u2");
    expect(found).not.toBeNull();
    expect(found!.id).toBe("s2");
  });

  it("retrieves by anonymousId", () => {
    repo.create({ id: "s3", userId: null, anonymousId: "anon-1", woprSessionName: "onboarding-anon-1", status: "active" });
    const found = repo.getByAnonymousId("anon-1");
    expect(found).not.toBeNull();
    expect(found!.id).toBe("s3");
  });

  it("upgrades anonymous to user", () => {
    repo.create({ id: "s4", userId: null, anonymousId: "anon-2", woprSessionName: "onboarding-anon-2", status: "active" });
    const upgraded = repo.upgradeAnonymousToUser("anon-2", "u3");
    expect(upgraded).not.toBeNull();
    expect(upgraded!.userId).toBe("u3");
    expect(upgraded!.anonymousId).toBe("anon-2");
  });

  it("updates budget used", () => {
    repo.create({ id: "s5", userId: "u4", anonymousId: null, woprSessionName: "onboarding-u4", status: "active" });
    repo.updateBudgetUsed("s5", 50);
    const found = repo.getById("s5");
    expect(found!.budgetUsedCents).toBe(50);
  });

  it("sets status", () => {
    repo.create({ id: "s6", userId: "u5", anonymousId: null, woprSessionName: "onboarding-u5", status: "active" });
    repo.setStatus("s6", "transferred");
    const found = repo.getById("s6");
    expect(found!.status).toBe("transferred");
  });

  it("returns null for missing id", () => {
    expect(repo.getById("nonexistent")).toBeNull();
  });
});
