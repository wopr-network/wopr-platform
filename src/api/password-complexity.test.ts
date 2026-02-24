/**
 * Tests for the password complexity middleware on sign-up and reset-password routes.
 * These routes enforce complexity before forwarding to better-auth.
 */
import { describe, expect, it } from "vitest";
import { app } from "./app.js";

async function postJson(path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("password complexity middleware", () => {
  describe("POST /api/auth/sign-up/email", () => {
    it("rejects a password missing uppercase", async () => {
      const res = await postJson("/api/auth/sign-up/email", {
        email: "a@b.com",
        password: "alllower1!xyz", // >= 12 chars, no uppercase
        name: "Test",
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/uppercase/i);
    });

    it("rejects a password missing a number", async () => {
      const res = await postJson("/api/auth/sign-up/email", {
        email: "a@b.com",
        password: "NoNumbers!abcdef", // >= 12 chars, no digit
        name: "Test",
      });
      expect(res.status).toBe(400);
    });

    it("rejects a password missing a special character", async () => {
      const res = await postJson("/api/auth/sign-up/email", {
        email: "a@b.com",
        password: "NoSpecial1abcde", // >= 12 chars, no special char
        name: "Test",
      });
      expect(res.status).toBe(400);
    });

    it("passes through a short password (let better-auth handle it)", async () => {
      // Passwords under 12 chars are not rejected by complexity check — let better-auth handle
      const res = await postJson("/api/auth/sign-up/email", {
        email: "a@b.com",
        password: "Short1!",
        name: "Test",
      });
      // Not a 400 from our middleware (better-auth may return its own error)
      expect(res.status).not.toBe(400);
    });

    it("passes through when body is not parseable JSON (no Content-Type)", async () => {
      const res = await app.request("/api/auth/sign-up/email", {
        method: "POST",
        body: "not json",
      });
      // Our middleware catches parse failure and falls through; better-auth handles it
      expect(res.status).not.toBe(400);
    });
  });

  describe("POST /api/auth/reset-password", () => {
    it("rejects a password missing lowercase", async () => {
      const res = await postJson("/api/auth/reset-password", {
        token: "sometoken",
        password: "ALLUPPER1!XXXX", // >= 12 chars, no lowercase
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/lowercase/i);
    });

    it("rejects a password missing a digit", async () => {
      const res = await postJson("/api/auth/reset-password", {
        token: "sometoken",
        password: "NoDigitHere!abcde", // >= 12 chars, no digit
      });
      expect(res.status).toBe(400);
    });

    it("passes through a short password (let better-auth handle it)", async () => {
      const res = await postJson("/api/auth/reset-password", {
        token: "sometoken",
        password: "Short1!",
      });
      expect(res.status).not.toBe(400);
    });

    it("passes through when body is not parseable (falls through to better-auth)", async () => {
      const res = await app.request("/api/auth/reset-password", {
        method: "POST",
        body: "not json",
      });
      expect(res.status).not.toBe(400);
    });
  });
});
