import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { PluginManifest } from "../../../src/api/routes/marketplace-registry.js";
import { createSetupRoutes, type SetupRouteDeps } from "../../../src/api/routes/setup.js";

const discordManifest: PluginManifest = {
  id: "discord-channel",
  name: "Discord",
  description: "Connect your WOPR instance to Discord servers.",
  version: "3.2.0",
  author: "WOPR Team",
  icon: "MessageCircle",
  color: "#5865F2",
  category: "channel",
  tags: ["channel"],
  capabilities: ["channel"],
  requires: [],
  install: [],
  configSchema: [
    { key: "botToken", label: "Bot Token", type: "string", required: true, secret: true },
  ],
  setup: [],
  installCount: 0,
  changelog: [],
};

function makeDeps(overrides: Partial<SetupRouteDeps> = {}): SetupRouteDeps {
  return {
    pluginRegistry: [discordManifest],
    setupSessionRepo: {
      findById: vi.fn().mockResolvedValue(undefined),
      findBySessionId: vi.fn().mockResolvedValue(undefined),
      findStale: vi.fn().mockResolvedValue([]),
      insert: vi.fn().mockImplementation(async (s) => ({
        ...s,
        collected: null,
        dependenciesInstalled: null,
        completedAt: null,
      })),
      update: vi.fn(),
      markComplete: vi.fn(),
      markRolledBack: vi.fn(),
    },
    onboardingService: {
      inject: vi.fn().mockResolvedValue("I'll help you set up Discord!"),
    } as SetupRouteDeps["onboardingService"],
    ...overrides,
  };
}

describe("POST /api/chat/setup", () => {
  it("returns 400 if sessionId is missing", async () => {
    const deps = makeDeps();
    const app = new Hono();
    app.route("/", createSetupRoutes(deps));

    const res = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pluginId: "discord-channel" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 if pluginId is missing", async () => {
    const deps = makeDeps();
    const app = new Hono();
    app.route("/", createSetupRoutes(deps));

    const res = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "abc-123" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 if plugin not in registry", async () => {
    const deps = makeDeps();
    const app = new Hono();
    app.route("/", createSetupRoutes(deps));

    const res = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "abc-123", pluginId: "nonexistent-plugin" }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 200, creates setup session, and injects context", async () => {
    const deps = makeDeps();
    const app = new Hono();
    app.route("/", createSetupRoutes(deps));

    const res = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "abc-123", pluginId: "discord-channel" }),
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.setupSessionId).toBeDefined();

    // Verify repo.insert was called
    expect(deps.setupSessionRepo.insert).toHaveBeenCalledOnce();
    const insertArg = (deps.setupSessionRepo.insert as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(insertArg.sessionId).toBe("abc-123");
    expect(insertArg.pluginId).toBe("discord-channel");
    expect(insertArg.status).toBe("in_progress");

    // Verify onboardingService.inject was called with setup context
    expect(deps.onboardingService.inject).toHaveBeenCalledOnce();
    const [injectedSessionId, injectedMessage] = (
      deps.onboardingService.inject as ReturnType<typeof vi.fn>
    ).mock.calls[0];
    expect(injectedSessionId).toBe("abc-123");
    expect(injectedMessage).toContain("botToken");
    expect(injectedMessage).toContain("setup.complete()");
    expect(injectedMessage).toContain("setup.rollback()");
  });

  it("returns 409 if setup session already in progress for this session", async () => {
    const deps = makeDeps({
      setupSessionRepo: {
        ...makeDeps().setupSessionRepo,
        findBySessionId: vi.fn().mockResolvedValue({
          id: "existing",
          sessionId: "abc-123",
          pluginId: "discord-channel",
          status: "in_progress",
          startedAt: Date.now(),
          collected: null,
          dependenciesInstalled: null,
          completedAt: null,
        }),
      },
    });
    const app = new Hono();
    app.route("/", createSetupRoutes(deps));

    const res = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "abc-123", pluginId: "discord-channel" }),
    });
    expect(res.status).toBe(409);
  });

  it("returns 500 if onboardingService.inject throws", async () => {
    const deps = makeDeps({
      onboardingService: {
        inject: vi.fn().mockRejectedValue(new Error("WOPR session not active")),
      },
    });
    const app = new Hono();
    app.route("/", createSetupRoutes(deps));

    const res = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "abc-123", pluginId: "discord-channel" }),
    });
    expect(res.status).toBe(500);
  });
});
