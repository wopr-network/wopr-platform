import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminNotifier } from "./admin-notifier.js";

// Mock the logger module
vi.mock("../config/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { logger } from "../config/logger.js";

const WEBHOOK_URL = "https://hooks.example.com/test";

describe("AdminNotifier", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("gpuNodeDegraded", () => {
    it("logs degraded event with service health details", async () => {
      const notifier = new AdminNotifier();
      const health: Record<string, "ok" | "down"> = { whisper: "ok", piper: "down" };

      await notifier.gpuNodeDegraded("gpu-node-1", health);

      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("gpu-node-1"));
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("piper"));
    });

    it("sends webhook when webhookUrl is configured", async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      vi.stubGlobal("fetch", fetchMock);

      const notifier = new AdminNotifier({ webhookUrl: WEBHOOK_URL });
      const health: Record<string, "ok" | "down"> = { whisper: "down" };

      await notifier.gpuNodeDegraded("gpu-node-2", health);

      expect(fetchMock).toHaveBeenCalledWith(WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: expect.stringContaining("gpu_node_degraded"),
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.type).toBe("gpu_node_degraded");
      expect(body.node_id).toBe("gpu-node-2");
      expect(body.service_health).toEqual({ whisper: "down" });
    });

    it("does not send webhook when webhookUrl is not configured", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = new AdminNotifier();
      await notifier.gpuNodeDegraded("gpu-node-3", { whisper: "ok" });

      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("gpuNodeFailed", () => {
    it("logs failure event", async () => {
      const notifier = new AdminNotifier();

      await notifier.gpuNodeFailed("gpu-node-4");

      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("gpu-node-4"));
    });

    it("sends webhook when webhookUrl is configured", async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      vi.stubGlobal("fetch", fetchMock);

      const notifier = new AdminNotifier({ webhookUrl: WEBHOOK_URL });

      await notifier.gpuNodeFailed("gpu-node-5");

      expect(fetchMock).toHaveBeenCalledWith(WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: expect.stringContaining("gpu_node_failed"),
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.type).toBe("gpu_node_failed");
      expect(body.node_id).toBe("gpu-node-5");
    });

    it("does not send webhook when webhookUrl is not configured", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = new AdminNotifier();
      await notifier.gpuNodeFailed("gpu-node-6");

      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
