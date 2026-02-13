import { describe, expect, it } from "vitest";
import { app } from "./app.js";

describe("CORS middleware", () => {
  const defaultOrigin = "http://localhost:3001";

  it("includes CORS headers on a simple GET request", async () => {
    const res = await app.request("/health", {
      headers: { Origin: defaultOrigin },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(defaultOrigin);
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true");
  });

  it("responds to preflight OPTIONS with allowed methods and headers", async () => {
    const res = await app.request("/health", {
      method: "OPTIONS",
      headers: {
        Origin: defaultOrigin,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "Content-Type, Authorization",
      },
    });
    expect(res.status).toBe(204);

    const allowMethods = res.headers.get("Access-Control-Allow-Methods");
    expect(allowMethods).toContain("GET");
    expect(allowMethods).toContain("POST");
    expect(allowMethods).toContain("PUT");
    expect(allowMethods).toContain("PATCH");
    expect(allowMethods).toContain("DELETE");

    const allowHeaders = res.headers.get("Access-Control-Allow-Headers");
    expect(allowHeaders).toContain("Content-Type");
    expect(allowHeaders).toContain("Authorization");

    expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true");
  });

  it("rejects requests from disallowed origins", async () => {
    const res = await app.request("/health", {
      headers: { Origin: "https://evil.example.com" },
    });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});
