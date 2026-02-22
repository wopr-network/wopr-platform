import { eq, lt, sql } from "drizzle-orm";
import type { DrizzleDb } from "../db/index.js";
import { sessions } from "../db/schema/index.js";
import type { SessionRecord } from "./repository-types.js";
import type { ISessionRepository } from "./session-repository.js";

export class DrizzleSessionRepository implements ISessionRepository {
  constructor(private readonly db: DrizzleDb) {}

  create(session: SessionRecord): SessionRecord {
    this.db
      .insert(sessions)
      .values({
        id: session.id,
        userId: session.userId,
        roles: JSON.stringify(session.roles),
        createdAt: session.createdAt,
        expiresAt: session.expiresAt,
      })
      .run();
    return session;
  }

  validate(sessionId: string): SessionRecord | null {
    const row = this.db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
    if (!row) return null;

    if (Date.now() > row.expiresAt) {
      this.db.delete(sessions).where(eq(sessions.id, sessionId)).run();
      return null;
    }

    return {
      id: row.id,
      userId: row.userId,
      roles: JSON.parse(row.roles) as string[],
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
    };
  }

  revoke(sessionId: string): boolean {
    const result = this.db.delete(sessions).where(eq(sessions.id, sessionId)).run();
    return result.changes > 0;
  }

  purgeExpired(): number {
    const result = this.db.delete(sessions).where(lt(sessions.expiresAt, Date.now())).run();
    return result.changes;
  }

  get size(): number {
    return this.db.select({ count: sql<number>`count(*)` }).from(sessions).get()?.count ?? 0;
  }
}
