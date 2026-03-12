import { randomUUID } from "node:crypto";
import type { AuditEnv } from "@wopr-network/platform-core/audit/types";
import type {
  CredentialSummaryRow,
  ISecretAuditRepository,
  SecretAuditEvent,
} from "@wopr-network/platform-core/security";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSecretAuditRoutes } from "./secret-audit.js";

// In-memory repo for testing
class FakeSecretAuditRepo implements ISecretAuditRepository {
  events: SecretAuditEvent[] = [];

  async insert(event: SecretAuditEvent): Promise<void> {
    this.events.push(event);
  }

  async listByCredentialId(credentialId: string, opts: { limit: number; offset: number }): Promise<SecretAuditEvent[]> {
    const filtered = this.events
      .filter((e) => e.credentialId === credentialId)
      .sort((a, b) => b.accessedAt - a.accessedAt);
    return filtered.slice(opts.offset, opts.offset + opts.limit);
  }

  async countByCredentialId(credentialId: string): Promise<number> {
    return this.events.filter((e) => e.credentialId === credentialId).length;
  }
}

describe("GET /secrets/:id/audit", () => {
  let app: Hono<AuditEnv>;
  let fakeRepo: FakeSecretAuditRepo;
  const mockGetCredentialOwner = vi.fn<(id: string) => Promise<CredentialSummaryRow | null>>();
  const userId = "user-123";
  const credentialId = "cred-456";

  beforeEach(() => {
    fakeRepo = new FakeSecretAuditRepo();
    mockGetCredentialOwner.mockReset();

    const routes = createSecretAuditRoutes(() => fakeRepo, mockGetCredentialOwner);
    app = new Hono<AuditEnv>();
    // Simulate session user middleware
    app.use("/*", async (c, next) => {
      c.set("user", { id: userId });
      await next();
    });
    app.route("/secrets", routes);
  });

  it("returns 401 when no user in context", async () => {
    const noAuthApp = new Hono();
    const routes = createSecretAuditRoutes(() => fakeRepo, mockGetCredentialOwner);
    noAuthApp.route("/secrets", routes);

    const res = await noAuthApp.request(`/secrets/${credentialId}/audit`);
    expect(res.status).toBe(401);
  });

  it("returns 404 when credential does not exist", async () => {
    mockGetCredentialOwner.mockResolvedValue(null);

    const res = await app.request(`/secrets/${credentialId}/audit`);
    expect(res.status).toBe(404);
  });

  it("returns 404 when credential owned by different user", async () => {
    mockGetCredentialOwner.mockResolvedValue({
      id: credentialId,
      provider: "anthropic",
      keyName: "test",
      authType: "bearer",
      authHeader: null,
      isActive: true,
      lastValidated: null,
      createdAt: new Date().toISOString(),
      rotatedAt: null,
      createdBy: "other-user",
    });

    const res = await app.request(`/secrets/${credentialId}/audit`);
    expect(res.status).toBe(404);
  });

  it("returns paginated events for owned credential", async () => {
    mockGetCredentialOwner.mockResolvedValue({
      id: credentialId,
      provider: "anthropic",
      keyName: "test",
      authType: "bearer",
      authHeader: null,
      isActive: true,
      lastValidated: null,
      createdAt: new Date().toISOString(),
      rotatedAt: null,
      createdBy: userId,
    });

    // Seed 3 events
    for (let i = 0; i < 3; i++) {
      await fakeRepo.insert({
        id: randomUUID(),
        credentialId,
        accessedAt: 1000 + i,
        accessedBy: userId,
        action: "read",
        ip: "10.0.0.1",
      });
    }

    const res = await app.request(`/secrets/${credentialId}/audit?limit=2&offset=0`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.events).toHaveLength(2);
    expect(body.total).toBe(3);
    expect(new Date(body.events[0].accessedAt).getTime()).toBeGreaterThan(
      new Date(body.events[1].accessedAt).getTime(),
    );
  });

  it("returns events with correct shape", async () => {
    mockGetCredentialOwner.mockResolvedValue({
      id: credentialId,
      provider: "anthropic",
      keyName: "test",
      authType: "bearer",
      authHeader: null,
      isActive: true,
      lastValidated: null,
      createdAt: new Date().toISOString(),
      rotatedAt: null,
      createdBy: userId,
    });

    const eventId = randomUUID();
    await fakeRepo.insert({
      id: eventId,
      credentialId,
      accessedAt: 1234567890,
      accessedBy: userId,
      action: "write",
      ip: "192.168.1.1",
    });

    const res = await app.request(`/secrets/${credentialId}/audit`);
    const body = await res.json();

    expect(body.events[0]).toEqual({
      id: eventId,
      accessedAt: new Date(1234567890).toISOString(),
      accessedBy: userId,
      action: "write",
      ip: "192.168.1.1",
    });
  });
});
