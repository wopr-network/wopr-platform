import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

  describe("POST /api/fleet/seed", () => {
    let origEnv: string | undefined;

    beforeEach(() => {
      origEnv = process.env.FLEET_TEMPLATES_DIR;
    });

    afterEach(() => {
      if (origEnv === undefined) {
        delete process.env.FLEET_TEMPLATES_DIR;
      } else {
        process.env.FLEET_TEMPLATES_DIR = origEnv;
      }
    });

    it("returns 200 with created bots when templates exist", async () => {
      process.env.FLEET_TEMPLATES_DIR = path.resolve(import.meta.dirname, "..", "..", "..", "templates");
      const res = await app.request("/api/fleet/seed", { method: "POST" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty("created");
      expect(body).toHaveProperty("skipped");
      expect(Array.isArray(body.created)).toBe(true);
    });

    it("returns 404 when templates directory is empty", async () => {
      process.env.FLEET_TEMPLATES_DIR = path.resolve(import.meta.dirname);
      const res = await app.request("/api/fleet/seed", { method: "POST" });
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body).toHaveProperty("error");
    });
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
