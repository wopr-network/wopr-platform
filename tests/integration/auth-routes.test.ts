/**
 * Integration tests for auth route wiring in /api/auth/*.
 *
 * Tests that the password-complexity middleware correctly intercepts sign-up
 * and reset-password, and that auth requests are forwarded to better-auth.
 */
import { describe, expect, it, vi } from "vitest";

// Mock better-auth BEFORE importing setup or app, so the lazy import in app.ts
// picks up the mock when it first calls getAuth().
const mockAuthHandler = vi.fn();

vi.mock("../../src/auth/better-auth.js", () => ({
  getAuth: () => ({
    handler: mockAuthHandler,
    api: {
      getSession: vi.fn().mockResolvedValue(null),
    },
  }),
}));

// Re-use the integration setup for env vars and other mocks
await import("./setup.js");

const { app } = await import("../../src/api/app.js");

describe("integration: auth route wiring", () => {
  it("POST /api/auth/sign-in/email delegates to better-auth handler", async () => {
    mockAuthHandler.mockResolvedValue(
      new Response(JSON.stringify({ session: { token: "abc" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const res = await app.request("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "test@example.com", password: "Test1234!@#$ab" }),
    });

    expect(mockAuthHandler).toHaveBeenCalled();
    expect(res.status).toBe(200);
  });

  it("GET /api/auth/get-session delegates to better-auth handler", async () => {
    mockAuthHandler.mockResolvedValue(
      new Response(JSON.stringify({ user: null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const res = await app.request("/api/auth/get-session", {
      method: "GET",
    });

    expect(mockAuthHandler).toHaveBeenCalled();
    expect(res.status).toBe(200);
  });

  it("POST /api/auth/sign-up/email rejects passwords missing uppercase", async () => {
    const res = await app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "test@example.com", password: "alllowercase1!" }),
    });

    // Password lacks uppercase — should be rejected by complexity middleware
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("uppercase");
  });

  it("POST /api/auth/sign-up/email passes strong passwords to better-auth", async () => {
    mockAuthHandler.mockResolvedValue(
      new Response(JSON.stringify({ user: { id: "u1" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const res = await app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "test@example.com",
        name: "Test",
        password: "MyStr0ng!Pass",
      }),
    });

    expect(mockAuthHandler).toHaveBeenCalled();
    expect(res.status).toBe(200);
  });

  it("POST /api/auth/reset-password rejects passwords missing uppercase", async () => {
    const res = await app.request("/api/auth/reset-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "reset-token", password: "nouppercase1!" }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("uppercase");
  });

  it("POST /api/auth/reset-password passes strong passwords to better-auth", async () => {
    mockAuthHandler.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const res = await app.request("/api/auth/reset-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "reset-token", password: "NewStr0ng!Pass" }),
    });

    expect(mockAuthHandler).toHaveBeenCalled();
    expect(res.status).toBe(200);
  });
});
