import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WoprClient } from "../../src/onboarding/wopr-client.js";

describe("WoprClient", () => {
  let client: WoprClient;

  beforeEach(() => {
    client = new WoprClient(3847);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("healthCheck returns true on 200 response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    const result = await client.healthCheck();
    expect(result).toBe(true);
  });

  it("healthCheck returns false on error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    const result = await client.healthCheck();
    expect(result).toBe(false);
  });

  it("healthCheck returns false on non-200 response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    const result = await client.healthCheck();
    expect(result).toBe(false);
  });

  it("createSession sends POST to /api/sessions", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, text: async () => "" });
    vi.stubGlobal("fetch", mockFetch);
    await client.createSession("test-session", "test context");
    expect(mockFetch).toHaveBeenCalledWith(
      "http://127.0.0.1:3847/api/sessions",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("createSession throws on non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => "error" }));
    await expect(client.createSession("test-session", "ctx")).rejects.toThrow("500");
  });

  it("getSessionHistory sends GET with limit param", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ history: [{ ts: 1, from: "user", content: "hi", type: "text" }] }),
    });
    vi.stubGlobal("fetch", mockFetch);
    const history = await client.getSessionHistory("my-session", 10);
    expect(mockFetch).toHaveBeenCalledWith(
      "http://127.0.0.1:3847/api/sessions/my-session/history?limit=10",
      expect.any(Object),
    );
    expect(history).toHaveLength(1);
    expect(history[0].from).toBe("user");
  });

  it("inject sends POST and returns response string", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ response: "Hello there!" }),
    }));
    const result = await client.inject("my-session", "Hello");
    expect(result).toBe("Hello there!");
  });

  it("deleteSession sends DELETE", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, text: async () => "" });
    vi.stubGlobal("fetch", mockFetch);
    await client.deleteSession("my-session");
    expect(mockFetch).toHaveBeenCalledWith(
      "http://127.0.0.1:3847/api/sessions/my-session",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("sets auth token in Authorization header", async () => {
    client.setAuthToken("secret-token");
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", mockFetch);
    await client.healthCheck();
    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer secret-token" }),
      }),
    );
  });
});
