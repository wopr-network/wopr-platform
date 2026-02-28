import { describe, expect, it, vi } from "vitest";
import type { PluginManifest } from "./marketplace-registry.js";
import { createSetupRoutes, type SetupRouteDeps } from "./setup.js";

const TEST_BOT_ID = "a1b2c3d4-e5f6-4789-8abc-def012345678";

const TEST_PLUGIN = {
  id: "test-plugin",
  name: "Test Plugin",
  description: "A test plugin",
  version: "1.0.0",
  install: ["@wopr-network/test-plugin"],
  configSchema: [
    { key: "apiKey", label: "API Key", type: "string", secret: true, env: "TEST_API_KEY" },
    { key: "region", label: "Region", type: "string", env: "TEST_REGION" },
  ],
} as PluginManifest;

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: "setup-1",
    sessionId: "s1",
    pluginId: "test-plugin",
    status: "in_progress",
    collected: null,
    dependenciesInstalled: null,
    startedAt: Date.now(),
    completedAt: null,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<SetupRouteDeps> = {}): SetupRouteDeps {
  return {
    pluginRegistry: [TEST_PLUGIN],
    setupSessionRepo: {
      findBySessionId: vi.fn().mockResolvedValue(null),
      findById: vi.fn().mockResolvedValue(makeSession()),
      insert: vi.fn().mockResolvedValue(makeSession()),
      update: vi.fn().mockResolvedValue(makeSession()),
      markRolledBack: vi.fn().mockResolvedValue(undefined),
      markComplete: vi.fn().mockResolvedValue(undefined),
    } as never,
    onboardingService: {
      inject: vi.fn().mockResolvedValue("ok"),
    },
    setupService: {
      rollback: vi.fn().mockResolvedValue({ sessionId: "setup-1", configKeysRemoved: [], dependenciesRemoved: [] }),
      recordError: vi.fn().mockResolvedValue(0),
      recordSuccess: vi.fn().mockResolvedValue(undefined),
      cleanupStaleSessions: vi.fn().mockResolvedValue([]),
      checkForResumable: vi.fn().mockResolvedValue({ hasStaleSession: false }),
    } as never,
    checkProvider: vi.fn().mockResolvedValue({ configured: false }),
    pluginConfigRepo: {
      upsert: vi.fn().mockResolvedValue(undefined),
      findByBotAndPlugin: vi.fn().mockResolvedValue(null),
    } as never,
    profileStore: {
      get: vi.fn().mockResolvedValue({ id: TEST_BOT_ID, tenantId: "t1", env: {} }),
      save: vi.fn().mockResolvedValue(undefined),
    } as never,
    dispatchEnvUpdate: vi.fn().mockResolvedValue({ dispatched: true }),
    platformEncryptionSecret: "test-secret-32-bytes-long-padding!",
    ...overrides,
  };
}

describe("POST /api/chat/setup", () => {
  it("includes provider-not-configured hint in system message when provider is missing", async () => {
    const injectMock = vi.fn().mockResolvedValue("ok");
    const deps = makeDeps({
      onboardingService: { inject: injectMock },
      checkProvider: vi.fn().mockResolvedValue({ configured: false }),
    });
    const app = createSetupRoutes(deps);

    const res = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "s1", pluginId: "test-plugin" }),
    });

    expect(res.status).toBe(200);
    const injectedMsg = injectMock.mock.calls[0][1] as string;
    expect(injectedMsg).toContain("PROVIDER NOT CONFIGURED");
    expect(injectedMsg).toContain("setup.validateKey");
  });

  it("includes provider-already-configured hint when provider exists", async () => {
    const injectMock = vi.fn().mockResolvedValue("ok");
    const deps = makeDeps({
      onboardingService: { inject: injectMock },
      checkProvider: vi.fn().mockResolvedValue({ configured: true, provider: "anthropic" }),
    });
    const app = createSetupRoutes(deps);

    const res = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "s1", pluginId: "test-plugin" }),
    });

    expect(res.status).toBe(200);
    const injectedMsg = injectMock.mock.calls[0][1] as string;
    expect(injectedMsg).toContain("PROVIDER ALREADY CONFIGURED");
    expect(injectedMsg).toContain("anthropic");
    expect(injectedMsg).not.toContain("PROVIDER NOT CONFIGURED");
  });

  it("proceeds without provider hint when checkProvider is not provided", async () => {
    const injectMock = vi.fn().mockResolvedValue("ok");
    const deps = makeDeps({
      onboardingService: { inject: injectMock },
      checkProvider: undefined,
    });
    const app = createSetupRoutes(deps);

    const res = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "s1", pluginId: "test-plugin" }),
    });

    expect(res.status).toBe(200);
    const injectedMsg = injectMock.mock.calls[0][1] as string;
    expect(injectedMsg).not.toContain("PROVIDER NOT CONFIGURED");
    expect(injectedMsg).not.toContain("PROVIDER ALREADY CONFIGURED");
  });

  it("returns 404 when plugin not found", async () => {
    const deps = makeDeps();
    const app = createSetupRoutes(deps);

    const res = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "s1", pluginId: "unknown-plugin" }),
    });

    expect(res.status).toBe(404);
  });

  it("returns 409 when setup already in progress", async () => {
    const deps = makeDeps({
      setupSessionRepo: {
        findBySessionId: vi.fn().mockResolvedValue(makeSession()),
        insert: vi.fn(),
        markRolledBack: vi.fn(),
      } as never,
    });
    const app = createSetupRoutes(deps);

    const res = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "s1", pluginId: "test-plugin" }),
    });

    expect(res.status).toBe(409);
  });

  it("returns 400 on invalid JSON", async () => {
    const deps = makeDeps();
    const app = createSetupRoutes(deps);

    const res = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });

    expect(res.status).toBe(400);
  });
});

describe("POST /save", () => {
  it("saves config, encrypts secrets, injects env vars, and dispatches env update", async () => {
    const upsertMock = vi.fn().mockResolvedValue(undefined);
    const saveMock = vi.fn().mockResolvedValue(undefined);
    const dispatchMock = vi.fn().mockResolvedValue({ dispatched: true });
    const updateMock = vi.fn().mockResolvedValue(makeSession());
    const recordSuccessMock = vi.fn().mockResolvedValue(undefined);

    const deps = makeDeps({
      pluginConfigRepo: { upsert: upsertMock } as never,
      profileStore: {
        get: vi.fn().mockResolvedValue({ id: TEST_BOT_ID, tenantId: "t1", env: { EXISTING: "val" } }),
        save: saveMock,
      } as never,
      dispatchEnvUpdate: dispatchMock,
      setupSessionRepo: {
        findBySessionId: vi.fn().mockResolvedValue(null),
        findById: vi.fn().mockResolvedValue(makeSession()),
        update: updateMock,
        markRolledBack: vi.fn(),
        markComplete: vi.fn(),
      } as never,
      setupService: {
        recordSuccess: recordSuccessMock,
      } as never,
    });
    const app = createSetupRoutes(deps);

    const res = await app.request("/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        setupSessionId: "setup-1",
        botId: TEST_BOT_ID,
        values: { apiKey: "sk-test-key", region: "us-east-1" },
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.envKeysInjected).toContain("TEST_API_KEY");
    expect(body.envKeysInjected).toContain("TEST_REGION");
    expect(upsertMock).toHaveBeenCalled();
    expect(saveMock).toHaveBeenCalled();
    expect(dispatchMock).toHaveBeenCalledWith(
      TEST_BOT_ID,
      "t1",
      expect.objectContaining({ TEST_API_KEY: "sk-test-key", EXISTING: "val" }),
    );
    expect(updateMock).toHaveBeenCalledWith("setup-1", { collected: expect.any(String) });
    expect(recordSuccessMock).toHaveBeenCalledWith("setup-1");
  });

  it("returns 404 when setup session not found", async () => {
    const deps = makeDeps({
      setupSessionRepo: {
        findById: vi.fn().mockResolvedValue(undefined),
        findBySessionId: vi.fn(),
        markRolledBack: vi.fn(),
      } as never,
    });
    const app = createSetupRoutes(deps);

    const res = await app.request("/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ setupSessionId: "missing", botId: TEST_BOT_ID, values: {} }),
    });

    expect(res.status).toBe(404);
  });

  it("returns 400 when session is not in_progress", async () => {
    const deps = makeDeps({
      setupSessionRepo: {
        findById: vi.fn().mockResolvedValue(makeSession({ status: "completed" })),
        findBySessionId: vi.fn(),
        markRolledBack: vi.fn(),
      } as never,
    });
    const app = createSetupRoutes(deps);

    const res = await app.request("/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ setupSessionId: "setup-1", botId: TEST_BOT_ID, values: {} }),
    });

    expect(res.status).toBe(400);
  });

  it("returns 404 when bot profile not found", async () => {
    const deps = makeDeps({
      profileStore: {
        get: vi.fn().mockResolvedValue(null),
        save: vi.fn(),
      } as never,
    });
    const app = createSetupRoutes(deps);

    const res = await app.request("/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ setupSessionId: "setup-1", botId: TEST_BOT_ID, values: {} }),
    });

    expect(res.status).toBe(404);
  });

  it("returns 503 when platformEncryptionSecret is not configured", async () => {
    const deps = makeDeps({ platformEncryptionSecret: "" });
    const app = createSetupRoutes(deps);

    const res = await app.request("/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ setupSessionId: "setup-1", botId: TEST_BOT_ID, values: { apiKey: "key" } }),
    });

    expect(res.status).toBe(503);
  });

  it("skips env dispatch when no env mappings defined in schema", async () => {
    const dispatchMock = vi.fn();
    const saveMock = vi.fn();
    const deps = makeDeps({
      pluginRegistry: [
        {
          ...TEST_PLUGIN,
          configSchema: [{ key: "noEnvField", label: "No Env", type: "string", required: false }],
        },
      ],
      dispatchEnvUpdate: dispatchMock,
      profileStore: {
        get: vi.fn().mockResolvedValue({ id: TEST_BOT_ID, tenantId: "t1", env: {} }),
        save: saveMock,
      } as never,
    });
    const app = createSetupRoutes(deps);

    const res = await app.request("/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ setupSessionId: "setup-1", botId: TEST_BOT_ID, values: { noEnvField: "val" } }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.envKeysInjected).toHaveLength(0);
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(saveMock).not.toHaveBeenCalled();
  });

  it("returns 400 on invalid request body", async () => {
    const deps = makeDeps();
    const app = createSetupRoutes(deps);

    const res = await app.request("/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ setupSessionId: "ok" /* missing botId and values */ }),
    });

    expect(res.status).toBe(400);
  });
});
