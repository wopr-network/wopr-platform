import { describe, expect, it } from "vitest";
import { app } from "./app.js";

describe("Security headers", () => {
  it("sets Content-Security-Policy on API responses", async () => {
    const res = await app.request("/health");
    const csp = res.headers.get("Content-Security-Policy");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("sets Strict-Transport-Security with preload", async () => {
    const res = await app.request("/health");
    const hsts = res.headers.get("Strict-Transport-Security");
    expect(hsts).toContain("max-age=31536000");
    expect(hsts).toContain("includeSubDomains");
    expect(hsts).toContain("preload");
  });

  it("sets X-Frame-Options to DENY", async () => {
    const res = await app.request("/health");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
  });

  it("sets X-Content-Type-Options to nosniff", async () => {
    const res = await app.request("/health");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("sets Referrer-Policy to no-referrer", async () => {
    const res = await app.request("/health");
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
  });

  it("does not expose X-Powered-By", async () => {
    const res = await app.request("/health");
    expect(res.headers.get("X-Powered-By")).toBeNull();
  });

  it("includes security headers on error responses too", async () => {
    const res = await app.request("/nonexistent-route-12345");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
  });
});
