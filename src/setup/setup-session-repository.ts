import { and, eq, lt } from "drizzle-orm";
import type { DrizzleDb } from "../db/index.js";
import { setupSessions } from "../db/schema/index.js";

// ---------------------------------------------------------------------------
// Domain types (plain interfaces — no Drizzle imports)
// ---------------------------------------------------------------------------

export interface SetupSession {
  id: string;
  sessionId: string;
  pluginId: string;
  status: "in_progress" | "complete" | "rolled_back";
  collected: string | null;
  dependenciesInstalled: string | null;
  startedAt: number;
  completedAt: number | null;
}

export type NewSetupSession = Pick<SetupSession, "id" | "sessionId" | "pluginId" | "status" | "startedAt">;

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface ISetupSessionRepository {
  findById(id: string): Promise<SetupSession | undefined>;
  findBySessionId(sessionId: string): Promise<SetupSession | undefined>;
  findStale(olderThanMs: number): Promise<SetupSession[]>;
  insert(session: NewSetupSession): Promise<SetupSession>;
  update(id: string, patch: Partial<SetupSession>): Promise<SetupSession>;
  markRolledBack(id: string): Promise<void>;
  markComplete(id: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Drizzle implementation
// ---------------------------------------------------------------------------

type DbRow = typeof setupSessions.$inferSelect;

function toSession(row: DbRow): SetupSession {
  return {
    id: row.id,
    sessionId: row.sessionId,
    pluginId: row.pluginId,
    status: row.status as SetupSession["status"],
    collected: row.collected,
    dependenciesInstalled: row.dependenciesInstalled,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
  };
}

export class DrizzleSetupSessionRepository implements ISetupSessionRepository {
  constructor(private readonly db: DrizzleDb) {}

  async findById(id: string): Promise<SetupSession | undefined> {
    const rows = await this.db.select().from(setupSessions).where(eq(setupSessions.id, id));
    return rows[0] ? toSession(rows[0]) : undefined;
  }

  async findBySessionId(sessionId: string): Promise<SetupSession | undefined> {
    const rows = await this.db
      .select()
      .from(setupSessions)
      .where(and(eq(setupSessions.sessionId, sessionId), eq(setupSessions.status, "in_progress")));
    return rows[0] ? toSession(rows[0]) : undefined;
  }

  async findStale(olderThanMs: number): Promise<SetupSession[]> {
    const cutoff = Date.now() - olderThanMs;
    const rows = await this.db
      .select()
      .from(setupSessions)
      .where(and(eq(setupSessions.status, "in_progress"), lt(setupSessions.startedAt, cutoff)));
    return rows.map(toSession);
  }

  async insert(session: NewSetupSession): Promise<SetupSession> {
    const rows = await this.db
      .insert(setupSessions)
      .values({
        id: session.id,
        sessionId: session.sessionId,
        pluginId: session.pluginId,
        status: session.status,
        startedAt: session.startedAt,
        collected: null,
        dependenciesInstalled: null,
        completedAt: null,
      })
      .returning();
    return toSession(rows[0]);
  }

  async update(id: string, patch: Partial<SetupSession>): Promise<SetupSession> {
    const rows = await this.db.update(setupSessions).set(patch).where(eq(setupSessions.id, id)).returning();
    if (!rows[0]) throw new Error(`SetupSession not found: ${id}`);
    return toSession(rows[0]);
  }

  async markComplete(id: string): Promise<void> {
    const rows = await this.db
      .update(setupSessions)
      .set({ status: "complete", completedAt: Date.now() })
      .where(eq(setupSessions.id, id))
      .returning({ id: setupSessions.id });
    if (!rows[0]) throw new Error(`SetupSession not found: ${id}`);
  }

  async markRolledBack(id: string): Promise<void> {
    const rows = await this.db
      .update(setupSessions)
      .set({ status: "rolled_back", completedAt: Date.now() })
      .where(eq(setupSessions.id, id))
      .returning({ id: setupSessions.id });
    if (!rows[0]) throw new Error(`SetupSession not found: ${id}`);
  }
}
