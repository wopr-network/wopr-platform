import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DrizzleDb } from "../../src/db/index.js";
import { DrizzleOnboardingSessionRepository } from "../../src/onboarding/drizzle-onboarding-session-repository.js";
import { createTestDb, truncateAllTables } from "../../src/test/db.js";

describe("DrizzleOnboardingSessionRepository", () => {
  let repo: DrizzleOnboardingSessionRepository;
  let pool: PGlite;
  let db: DrizzleDb;

  beforeAll(async () => {
    const result = await createTestDb();
    pool = result.pool;
    db = result.db;
  });

  afterAll(async () => {
    await pool.close();
  });

  beforeEach(async () => {
    await truncateAllTables(pool);
    repo = new DrizzleOnboardingSessionRepository(db);
  });


  it("creates and retrieves a session by id", async () => {
    const session = await repo.create({
      id: "s1",
      userId: "u1",
      anonymousId: null,
      woprSessionName: "onboarding-u1",
      status: "active"});
    expect(session.id).toBe("s1");
    expect(session.userId).toBe("u1");

    const found = await repo.getById("s1");
    expect(found).not.toBeNull();
    expect(found!.woprSessionName).toBe("onboarding-u1");
  });

  it("retrieves by userId", async () => {
    await repo.create({ id: "s2", userId: "u2", anonymousId: null, woprSessionName: "onboarding-u2", status: "active" });
    const found = await repo.getByUserId("u2");
    expect(found).not.toBeNull();
    expect(found!.id).toBe("s2");
  });

  it("retrieves by anonymousId", async () => {
    await repo.create({ id: "s3", userId: null, anonymousId: "anon-1", woprSessionName: "onboarding-anon-1", status: "active" });
    const found = await repo.getByAnonymousId("anon-1");
    expect(found).not.toBeNull();
    expect(found!.id).toBe("s3");
  });

  it("upgrades anonymous to user", async () => {
    await repo.create({ id: "s4", userId: null, anonymousId: "anon-2", woprSessionName: "onboarding-anon-2", status: "active" });
    const upgraded = await repo.upgradeAnonymousToUser("anon-2", "u3");
    expect(upgraded).not.toBeNull();
    expect(upgraded!.userId).toBe("u3");
    expect(upgraded!.anonymousId).toBe("anon-2");
  });

  it("sets status", async () => {
    await repo.create({ id: "s6", userId: "u5", anonymousId: null, woprSessionName: "onboarding-u5", status: "active" });
    await repo.setStatus("s6", "transferred");
    const found = await repo.getById("s6");
    expect(found!.status).toBe("transferred");
  });

  it("returns null for missing id", async () => {
    expect(await repo.getById("nonexistent")).toBeNull();
  });

  describe("getActiveByAnonymousId", () => {
    it("returns active session created within 24h", async () => {
      await repo.create({
        id: "s10",
        userId: null,
        anonymousId: "anon-fresh",
        woprSessionName: "onboarding-s10",
        status: "active"});
      const result = await repo.getActiveByAnonymousId("anon-fresh");
      expect(result).not.toBeNull();
      expect(result!.id).toBe("s10");
    });

    it("returns null for session older than 24h", async () => {
      await repo.create({
        id: "s11",
        userId: null,
        anonymousId: "anon-stale",
        woprSessionName: "onboarding-s11",
        status: "active"});
      // Backdate createdAt to 25 hours ago via direct db update
      const { onboardingSessions } = await import("../../src/db/schema/index.js");
      const { eq } = await import("drizzle-orm");
      await (repo as any).db
        .update(onboardingSessions)
        .set({ createdAt: Date.now() - 25 * 60 * 60 * 1000 })
        .where(eq(onboardingSessions.id, "s11"));

      const result = await repo.getActiveByAnonymousId("anon-stale");
      expect(result).toBeNull();
    });

    it("returns null for non-active session", async () => {
      await repo.create({
        id: "s12",
        userId: null,
        anonymousId: "anon-expired",
        woprSessionName: "onboarding-s12",
        status: "active"});
      await repo.setStatus("s12", "expired");
      const result = await repo.getActiveByAnonymousId("anon-expired");
      expect(result).toBeNull();
    });

    it("returns null for unknown anonymousId", async () => {
      const result = await repo.getActiveByAnonymousId("nonexistent-anon");
      expect(result).toBeNull();
    });
  });
});
