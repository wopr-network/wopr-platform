import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
  ISetupSessionRepository,
  NewSetupSession,
  SetupSession,
} from "../../src/setup/setup-session-repository.js";

// Minimal in-memory implementation for interface contract testing
class InMemorySetupSessionRepository implements ISetupSessionRepository {
  private sessions = new Map<string, SetupSession>();

  async findById(id: string): Promise<SetupSession | undefined> {
    return this.sessions.get(id);
  }

  async findBySessionId(sessionId: string): Promise<SetupSession | undefined> {
    for (const s of this.sessions.values()) {
      if (s.sessionId === sessionId && s.status === "in_progress") return s;
    }
    return undefined;
  }

  async findStale(olderThanMs: number): Promise<SetupSession[]> {
    const cutoff = Date.now() - olderThanMs;
    return [...this.sessions.values()].filter(
      (s) => s.status === "in_progress" && s.startedAt < cutoff,
    );
  }

  async insert(session: NewSetupSession): Promise<SetupSession> {
    const full: SetupSession = {
      ...session,
      collected: null,
      dependenciesInstalled: null,
      completedAt: null,
    };
    this.sessions.set(session.id, full);
    return full;
  }

  async update(id: string, patch: Partial<SetupSession>): Promise<SetupSession> {
    const existing = this.sessions.get(id);
    if (!existing) throw new Error(`SetupSession not found: ${id}`);
    const updated = { ...existing, ...patch };
    this.sessions.set(id, updated);
    return updated;
  }

  async markComplete(id: string): Promise<void> {
    const existing = this.sessions.get(id);
    if (!existing) throw new Error(`SetupSession not found: ${id}`);
    this.sessions.set(id, { ...existing, status: "complete", completedAt: Date.now() });
  }

  async markRolledBack(id: string): Promise<void> {
    const existing = this.sessions.get(id);
    if (!existing) throw new Error(`SetupSession not found: ${id}`);
    this.sessions.set(id, { ...existing, status: "rolled_back", completedAt: Date.now() });
  }
}

describe("ISetupSessionRepository contract", () => {
  it("insert creates a setup session and findById retrieves it", async () => {
    const repo = new InMemorySetupSessionRepository();
    const id = randomUUID();
    const sessionId = randomUUID();
    const now = Date.now();

    await repo.insert({
      id,
      sessionId,
      pluginId: "discord-channel",
      status: "in_progress",
      startedAt: now,
    });
    const found = await repo.findById(id);
    expect(found).toBeDefined();
    expect(found!.pluginId).toBe("discord-channel");
    expect(found!.status).toBe("in_progress");
    expect(found!.collected).toBeNull();
  });

  it("findBySessionId returns in-progress session for a given onboarding session", async () => {
    const repo = new InMemorySetupSessionRepository();
    const id = randomUUID();
    const sessionId = randomUUID();
    await repo.insert({
      id,
      sessionId,
      pluginId: "discord-channel",
      status: "in_progress",
      startedAt: Date.now(),
    });

    const found = await repo.findBySessionId(sessionId);
    expect(found).toBeDefined();
    expect(found!.id).toBe(id);
  });

  it("findBySessionId does not return completed sessions", async () => {
    const repo = new InMemorySetupSessionRepository();
    const id = randomUUID();
    const sessionId = randomUUID();
    await repo.insert({
      id,
      sessionId,
      pluginId: "discord-channel",
      status: "in_progress",
      startedAt: Date.now(),
    });
    await repo.markComplete(id);

    const found = await repo.findBySessionId(sessionId);
    expect(found).toBeUndefined();
  });

  it("markComplete sets status and completedAt", async () => {
    const repo = new InMemorySetupSessionRepository();
    const id = randomUUID();
    await repo.insert({
      id,
      sessionId: randomUUID(),
      pluginId: "discord-channel",
      status: "in_progress",
      startedAt: Date.now(),
    });
    await repo.markComplete(id);

    const found = await repo.findById(id);
    expect(found!.status).toBe("complete");
    expect(found!.completedAt).toBeTypeOf("number");
  });

  it("markRolledBack sets status to rolled_back", async () => {
    const repo = new InMemorySetupSessionRepository();
    const id = randomUUID();
    await repo.insert({
      id,
      sessionId: randomUUID(),
      pluginId: "discord-channel",
      status: "in_progress",
      startedAt: Date.now(),
    });
    await repo.markRolledBack(id);

    const found = await repo.findById(id);
    expect(found!.status).toBe("rolled_back");
  });

  it("update patches collected JSON", async () => {
    const repo = new InMemorySetupSessionRepository();
    const id = randomUUID();
    await repo.insert({
      id,
      sessionId: randomUUID(),
      pluginId: "discord-channel",
      status: "in_progress",
      startedAt: Date.now(),
    });
    await repo.update(id, { collected: JSON.stringify({ botToken: "test-token" }) });

    const found = await repo.findById(id);
    expect(found!.collected).toBe(JSON.stringify({ botToken: "test-token" }));
  });

  it("update throws when session id does not exist", async () => {
    const repo = new InMemorySetupSessionRepository();
    const nonExistentId = randomUUID();
    await expect(repo.update(nonExistentId, { collected: "{}" })).rejects.toThrow(nonExistentId);
  });

  it("markComplete throws when session id does not exist", async () => {
    const repo = new InMemorySetupSessionRepository();
    const nonExistentId = randomUUID();
    await expect(repo.markComplete(nonExistentId)).rejects.toThrow(nonExistentId);
  });

  it("markRolledBack throws when session id does not exist", async () => {
    const repo = new InMemorySetupSessionRepository();
    const nonExistentId = randomUUID();
    await expect(repo.markRolledBack(nonExistentId)).rejects.toThrow(nonExistentId);
  });

  it("findStale returns sessions older than threshold", async () => {
    const repo = new InMemorySetupSessionRepository();
    const oldId = randomUUID();
    const newId = randomUUID();
    const sessionId = randomUUID();

    await repo.insert({
      id: oldId,
      sessionId,
      pluginId: "discord-channel",
      status: "in_progress",
      startedAt: Date.now() - 2000,
    });
    await repo.insert({
      id: newId,
      sessionId: randomUUID(),
      pluginId: "discord-channel",
      status: "in_progress",
      startedAt: Date.now(),
    });

    const stale = await repo.findStale(1000); // 1 second threshold
    expect(stale.some((s) => s.id === oldId)).toBe(true);
    expect(stale.some((s) => s.id === newId)).toBe(false);
  });
});
