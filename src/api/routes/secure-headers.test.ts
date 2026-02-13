import { describe, expect, it } from "vitest";
import { app } from "../app.js";

describe("secure headers middleware", () => {
  it("sets security headers on responses", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);

    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(res.headers.get("strict-transport-security")).toContain("max-age=");
    expect(res.headers.get("strict-transport-security")).toContain(
      "includeSubDomains",
    );
    expect(res.headers.get("x-xss-protection")).toBe("0");
  });

  it("sets security headers on non-existent routes", async () => {
    const res = await app.request("/nonexistent");

    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
  });
});
