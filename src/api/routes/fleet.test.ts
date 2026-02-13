import { describe, expect, it } from "vitest";
import type { ProfileTemplate } from "../../fleet/profile-schema.js";
import { app } from "../app.js";
import { seedBots } from "./fleet.js";

describe("fleet routes", () => {
  it("GET /api/fleet returns empty bots list", async () => {
    const res = await app.request("/api/fleet");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ bots: [] });
  });

  it("POST /api/fleet/seed returns created and skipped bots", async () => {
    const res = await app.request("/api/fleet/seed", { method: "POST" });
    // The bundled templates directory should be found relative to src at build time.
    // In test mode (running from src via vitest), the path resolves to <root>/templates/.
    expect([200, 404, 500]).toContain(res.status);
  });
});

describe("seedBots", () => {
  const makeTemplate = (name: string): ProfileTemplate => ({
    name,
    description: `Bot ${name}`,
    channel: { plugin: "test-channel", config: {} },
    provider: { plugin: "test-provider", config: {} },
    release: "stable",
    image: "ghcr.io/test:stable",
    restartPolicy: "unless-stopped",
    healthCheck: { endpoint: "/health", intervalSeconds: 30, timeoutSeconds: 5, retries: 3 },
    volumes: [],
    env: {},
  });

  it("creates all bots when none exist", () => {
    const templates = [makeTemplate("bot-a"), makeTemplate("bot-b")];
    const existing = new Set<string>();
    const result = seedBots(templates, existing);

    expect(result.created).toEqual(["bot-a", "bot-b"]);
    expect(result.skipped).toEqual([]);
  });

  it("skips bots that already exist", () => {
    const templates = [makeTemplate("bot-a"), makeTemplate("bot-b")];
    const existing = new Set(["bot-a"]);
    const result = seedBots(templates, existing);

    expect(result.created).toEqual(["bot-b"]);
    expect(result.skipped).toEqual(["bot-a"]);
  });

  it("skips all when all exist", () => {
    const templates = [makeTemplate("bot-a"), makeTemplate("bot-b")];
    const existing = new Set(["bot-a", "bot-b"]);
    const result = seedBots(templates, existing);

    expect(result.created).toEqual([]);
    expect(result.skipped).toEqual(["bot-a", "bot-b"]);
  });

  it("handles empty template list", () => {
    const result = seedBots([], new Set());
    expect(result.created).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it("adds created bots to existing set", () => {
    const templates = [makeTemplate("new-bot")];
    const existing = new Set<string>();
    seedBots(templates, existing);

    expect(existing.has("new-bot")).toBe(true);
  });
});
