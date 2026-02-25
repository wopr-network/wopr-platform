import { eq } from "drizzle-orm";
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
  budgetUsedCents: number;
}

export interface IOnboardingSessionRepository {
  getById(id: string): OnboardingSession | null;
  getByUserId(userId: string): OnboardingSession | null;
  getByAnonymousId(anonymousId: string): OnboardingSession | null;
  create(data: Omit<OnboardingSession, "createdAt" | "updatedAt" | "budgetUsedCents">): OnboardingSession;
  upgradeAnonymousToUser(anonymousId: string, userId: string): OnboardingSession | null;
  updateBudgetUsed(id: string, budgetUsedCents: number): void;
  setStatus(id: string, status: OnboardingSession["status"]): void;
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
    budgetUsedCents: row.budgetUsedCents,
  };
}

export class DrizzleOnboardingSessionRepository implements IOnboardingSessionRepository {
  constructor(private readonly db: DrizzleDb) {}

  getById(id: string): OnboardingSession | null {
    const row = this.db.select().from(onboardingSessions).where(eq(onboardingSessions.id, id)).get();
    return row ? toSession(row) : null;
  }

  getByUserId(userId: string): OnboardingSession | null {
    const row = this.db.select().from(onboardingSessions).where(eq(onboardingSessions.userId, userId)).get();
    return row ? toSession(row) : null;
  }

  getByAnonymousId(anonymousId: string): OnboardingSession | null {
    const row = this.db.select().from(onboardingSessions).where(eq(onboardingSessions.anonymousId, anonymousId)).get();
    return row ? toSession(row) : null;
  }

  create(data: Omit<OnboardingSession, "createdAt" | "updatedAt" | "budgetUsedCents">): OnboardingSession {
    const now = Date.now();
    const row = this.db
      .insert(onboardingSessions)
      .values({
        id: data.id,
        userId: data.userId ?? null,
        anonymousId: data.anonymousId ?? null,
        woprSessionName: data.woprSessionName,
        status: data.status,
        createdAt: now,
        updatedAt: now,
        budgetUsedCents: 0,
      })
      .returning()
      .get();
    return toSession(row);
  }

  upgradeAnonymousToUser(anonymousId: string, userId: string): OnboardingSession | null {
    const now = Date.now();
    const row = this.db
      .update(onboardingSessions)
      .set({ userId, updatedAt: now })
      .where(eq(onboardingSessions.anonymousId, anonymousId))
      .returning()
      .get();
    return row ? toSession(row) : null;
  }

  updateBudgetUsed(id: string, budgetUsedCents: number): void {
    this.db
      .update(onboardingSessions)
      .set({ budgetUsedCents, updatedAt: Date.now() })
      .where(eq(onboardingSessions.id, id))
      .run();
  }

  setStatus(id: string, status: OnboardingSession["status"]): void {
    this.db
      .update(onboardingSessions)
      .set({ status, updatedAt: Date.now() })
      .where(eq(onboardingSessions.id, id))
      .run();
  }
}
