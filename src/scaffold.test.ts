import { describe, expect, it } from "vitest";
import { app } from "./api/app.js";
import { config } from "./config/index.js";

describe("platform scaffold", () => {
  it("config loads with defaults", () => {
    expect(config.port).toBe(3100);
    expect(config.logLevel).toBeDefined();
  });

  it("hono app responds to health check", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
  });

  it("directory structure modules are importable", async () => {
    // These are comment-only placeholders but should be valid TS modules
    await expect(import("./observability/index.js")).resolves.toBeDefined();
    await expect(import("./monetization/index.js")).resolves.toBeDefined();
    await expect(import("./auth/index.js")).resolves.toBeDefined();
  });
});
