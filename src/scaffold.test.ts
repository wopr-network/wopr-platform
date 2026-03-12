import { config } from "@wopr-network/platform-core/config/index";
import { describe, expect, it } from "vitest";
import { app } from "./api/app.js";

describe("platform scaffold", () => {
  it("config loads with defaults", () => {
    expect(config.port).toBe(3100);
    expect(["error", "warn", "info", "debug"]).toContain(config.logLevel);
  });

  it("hono app responds to health check", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
  });

  it("directory structure modules are importable", async () => {
    // These are comment-only placeholders but should be valid TS modules
    await expect(import("@wopr-network/platform-core/observability/index")).resolves.toBeDefined();
    await expect(import("@wopr-network/platform-core/monetization/index")).resolves.toBeDefined();
    await expect(import("@wopr-network/platform-core/auth")).resolves.toBeDefined();
  });
});
