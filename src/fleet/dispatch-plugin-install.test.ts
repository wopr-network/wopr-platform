import { beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchPluginInstall } from "./dispatch-plugin-install.js";

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("dispatchPluginInstall", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("dispatches install to daemon and returns dispatched:true on success", async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve("") });

    const result = await dispatchPluginInstall("bot-1", "@wopr-network/plugin-discord");

    expect(result).toEqual({ dispatched: true });
    expect(mockFetch).toHaveBeenCalledWith(
      "http://wopr-bot-1:3000/plugins/install",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: "@wopr-network/plugin-discord" }),
      }),
    );
  });

  it("returns dispatched:false with error on non-ok response", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
      text: () => Promise.resolve("package not found"),
    });

    const result = await dispatchPluginInstall("bot-1", "nonexistent-pkg");

    expect(result).toEqual({ dispatched: false, dispatchError: "daemon returned 404: package not found" });
  });

  it("returns dispatched:false on connection error (bot offline)", async () => {
    mockFetch.mockRejectedValue(new Error("fetch failed"));

    const result = await dispatchPluginInstall("bot-1", "@wopr-network/plugin-discord");

    expect(result).toEqual({ dispatched: false, dispatchError: "fetch failed" });
  });

  it("handles non-Error thrown values", async () => {
    mockFetch.mockRejectedValue("string error");

    const result = await dispatchPluginInstall("bot-1", "pkg");

    expect(result).toEqual({ dispatched: false, dispatchError: "string error" });
  });
});
