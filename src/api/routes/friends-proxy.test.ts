import { beforeEach, describe, expect, it, vi } from "vitest";
import { proxyToInstance } from "./friends-proxy.js";

// We don't want real network calls — mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("proxyToInstance path validation", () => {
  beforeEach(() => {
    mockFetch.mockClear();
  });
  it("accepts valid /p2p/ prefixed paths", async () => {
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const result = await proxyToInstance("bot-1", "GET", "/p2p/friends");
    expect(result.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      "http://wopr-bot-1:3000/p2p/friends",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("accepts /p2p/ paths with sub-segments", async () => {
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const result = await proxyToInstance("bot-1", "POST", "/p2p/friends/requests/req-1/accept");
    expect(result.ok).toBe(true);
  });

  it("rejects paths not starting with /p2p/", async () => {
    await expect(proxyToInstance("bot-1", "GET", "/admin/shutdown")).rejects.toThrow(
      "proxyToInstance: disallowed path",
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("rejects empty path", async () => {
    await expect(proxyToInstance("bot-1", "GET", "")).rejects.toThrow("proxyToInstance: disallowed path");
  });

  it("rejects path traversal with ..", async () => {
    await expect(proxyToInstance("bot-1", "GET", "/p2p/../admin/shutdown")).rejects.toThrow(
      "proxyToInstance: disallowed path",
    );
  });

  it("rejects path with query string", async () => {
    await expect(proxyToInstance("bot-1", "GET", "/p2p/friends?redirect=http://evil.com")).rejects.toThrow(
      "proxyToInstance: disallowed path",
    );
  });

  it("rejects path with protocol injection", async () => {
    await expect(proxyToInstance("bot-1", "GET", "/p2p/friends://evil.com")).rejects.toThrow(
      "proxyToInstance: disallowed path",
    );
  });

  it("rejects path with CRLF characters", async () => {
    await expect(proxyToInstance("bot-1", "GET", "/p2p/friends\r\nX-Injected: true")).rejects.toThrow(
      "proxyToInstance: disallowed path",
    );
  });

  it("rejects path with encoded traversal (%2e%2e)", async () => {
    await expect(proxyToInstance("bot-1", "GET", "/p2p/%2e%2e/admin")).rejects.toThrow(
      "proxyToInstance: disallowed path",
    );
  });
});

describe("proxyToInstance method validation", () => {
  it("rejects invalid HTTP method", async () => {
    await expect(proxyToInstance("bot-1", "CONNECT", "/p2p/friends")).rejects.toThrow(
      "proxyToInstance: disallowed method",
    );
  });

  it("rejects lowercase method", async () => {
    await expect(proxyToInstance("bot-1", "get", "/p2p/friends")).rejects.toThrow("proxyToInstance: disallowed method");
  });
});
