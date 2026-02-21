import { describe, expect, it } from "vitest";
import { app } from "../app.js";

describe("health routes", () => {
  it("GET /health returns ok", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: "ok", service: "wopr-platform" });
  });

  it("GET /health/ready returns ready", async () => {
    const res = await app.request("/health/ready");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: "ready", service: "wopr-platform" });
  });
});
