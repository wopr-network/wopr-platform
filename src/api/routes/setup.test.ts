import { describe, expect, it, vi } from "vitest";
import { createSetupRoutes, type SetupRouteDeps } from "./setup.js";

function makeDeps(overrides: Partial<SetupRouteDeps> = {}): SetupRouteDeps {
  return {
    pluginRegistry: [
      {
        id: "test-plugin",
        name: "Test Plugin",
        description: "A test plugin",
        version: "1.0.0",
        install: ["@wopr-network/test-plugin"],
        configSchema: { type: "object", properties: { apiKey: { type: "string" } } },
      } as any,
    ],
    setupSessionRepo: {
      findBySessionId: vi.fn().mockResolvedValue(null),
      insert: vi.fn().mockResolvedValue({
        id: "setup-1",
        sessionId: "s1",
        pluginId: "test-plugin",
        status: "in_progress",
        collected: null,
        dependenciesInstalled: null,
        startedAt: Date.now(),
        completedAt: null,
      }),
      markRolledBack: vi.fn(),
    } as any,
    onboardingService: {
      inject: vi.fn().mockResolvedValue("ok"),
    },
    checkProvider: vi.fn().mockResolvedValue({ configured: false }),
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
});
