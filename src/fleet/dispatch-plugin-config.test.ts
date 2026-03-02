import { beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchPluginConfig } from "./dispatch-plugin-config.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("dispatchPluginConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("dispatches config to daemon and returns dispatched:true on success", async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve("") });

    const result = await dispatchPluginConfig("bot-1", "discord", { token: "abc" });

    expect(result).toEqual({ dispatched: true });
    expect(mockFetch).toHaveBeenCalledWith(
      "http://wopr-bot-1:3000/plugins/discord/config",
      expect.objectContaining({
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: { token: "abc" } }),
      }),
    );
  });

  it("returns dispatched:false with error on non-ok response", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      text: () => Promise.resolve("invalid config"),
    });

    const result = await dispatchPluginConfig("bot-1", "discord", {});

    expect(result).toEqual({ dispatched: false, dispatchError: "daemon returned 400: invalid config" });
  });

  it("returns dispatched:false on connection error (bot offline)", async () => {
    mockFetch.mockRejectedValue(new Error("connect ECONNREFUSED"));

    const result = await dispatchPluginConfig("bot-1", "discord", {});

    expect(result).toEqual({ dispatched: false, dispatchError: "connect ECONNREFUSED" });
  });

  it("handles non-Error thrown values", async () => {
    mockFetch.mockRejectedValue("string error");

    const result = await dispatchPluginConfig("bot-1", "discord", {});

    expect(result).toEqual({ dispatched: false, dispatchError: "string error" });
  });
});
