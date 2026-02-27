import { and, eq, gt } from "drizzle-orm";
import type { DrizzleDb } from "../db/index.js";
import { onboardingSessions } from "../db/schema/index.js";

export interface OnboardingSession {
  id: string;
  userId: string | null;
  anonymousId: string | null;
  woprSessionName: string;
  status: "active" | "transferred" | "expired";
  createdAt: number;
  updatedAt: number;
  budgetUsedCredits: number;
}

export interface IOnboardingSessionRepository {
  getById(id: string): Promise<OnboardingSession | null>;
  getByUserId(userId: string): Promise<OnboardingSession | null>;
  getByAnonymousId(anonymousId: string): Promise<OnboardingSession | null>;
  getActiveByAnonymousId(anonymousId: string): Promise<OnboardingSession | null>;
  create(data: Omit<OnboardingSession, "createdAt" | "updatedAt" | "budgetUsedCredits">): Promise<OnboardingSession>;
  upgradeAnonymousToUser(anonymousId: string, userId: string): Promise<OnboardingSession | null>;
  updateBudgetUsed(id: string, budgetUsedCredits: number): Promise<void>;
  setStatus(id: string, status: OnboardingSession["status"]): Promise<void>;
}

type DbRow = typeof onboardingSessions.$inferSelect;

function toSession(row: DbRow): OnboardingSession {
  return {
    id: row.id,
    userId: row.userId,
    anonymousId: row.anonymousId,
    woprSessionName: row.woprSessionName,
    status: row.status as OnboardingSession["status"],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    budgetUsedCredits: row.budgetUsedCredits,
  };
}

export class DrizzleOnboardingSessionRepository implements IOnboardingSessionRepository {
  constructor(private readonly db: DrizzleDb) {}

  async getById(id: string): Promise<OnboardingSession | null> {
    const rows = await this.db.select().from(onboardingSessions).where(eq(onboardingSessions.id, id));
    return rows[0] ? toSession(rows[0]) : null;
  }

  async getByUserId(userId: string): Promise<OnboardingSession | null> {
    const rows = await this.db.select().from(onboardingSessions).where(eq(onboardingSessions.userId, userId));
    return rows[0] ? toSession(rows[0]) : null;
  }

  async getByAnonymousId(anonymousId: string): Promise<OnboardingSession | null> {
    const rows = await this.db.select().from(onboardingSessions).where(eq(onboardingSessions.anonymousId, anonymousId));
    return rows[0] ? toSession(rows[0]) : null;
  }

  async getActiveByAnonymousId(anonymousId: string): Promise<OnboardingSession | null> {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const rows = await this.db
      .select()
      .from(onboardingSessions)
      .where(
        and(
          eq(onboardingSessions.anonymousId, anonymousId),
          eq(onboardingSessions.status, "active"),
          gt(onboardingSessions.createdAt, cutoff),
        ),
      );
    return rows[0] ? toSession(rows[0]) : null;
  }

  async create(
    data: Omit<OnboardingSession, "createdAt" | "updatedAt" | "budgetUsedCredits">,
  ): Promise<OnboardingSession> {
    const now = Date.now();
    const rows = await this.db
      .insert(onboardingSessions)
      .values({
        id: data.id,
        userId: data.userId ?? null,
        anonymousId: data.anonymousId ?? null,
        woprSessionName: data.woprSessionName,
        status: data.status,
        createdAt: now,
        updatedAt: now,
        budgetUsedCredits: 0,
      })
      .returning();
    return toSession(rows[0]);
  }

  async upgradeAnonymousToUser(anonymousId: string, userId: string): Promise<OnboardingSession | null> {
    const now = Date.now();
    const rows = await this.db
      .update(onboardingSessions)
      .set({ userId, updatedAt: now })
      .where(eq(onboardingSessions.anonymousId, anonymousId))
      .returning();
    return rows[0] ? toSession(rows[0]) : null;
  }

  async updateBudgetUsed(id: string, budgetUsedCredits: number): Promise<void> {
    await this.db
      .update(onboardingSessions)
      .set({ budgetUsedCredits, updatedAt: Date.now() })
      .where(eq(onboardingSessions.id, id));
  }

  async setStatus(id: string, status: OnboardingSession["status"]): Promise<void> {
    await this.db
      .update(onboardingSessions)
      .set({ status, updatedAt: Date.now() })
      .where(eq(onboardingSessions.id, id));
  }
}
