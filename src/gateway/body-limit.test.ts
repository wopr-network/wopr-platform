import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { audioBodyLimit, BODY_LIMITS, llmBodyLimit, webhookBodyLimit } from "./body-limit.js";

describe("gateway body size limits", () => {
  function buildApp(middleware: ReturnType<typeof llmBodyLimit>) {
    const app = new Hono();
    app.post("/test", middleware, async (c) => {
      const body = await c.req.text();
      return c.json({ size: body.length });
    });
    return app;
  }

  describe("llmBodyLimit (10MB)", () => {
    const app = buildApp(llmBodyLimit());

    it("allows requests under the limit", async () => {
      const body = "x".repeat(1000);
      const res = await app.request("/test", {
        method: "POST",
        body,
        headers: { "Content-Type": "text/plain" },
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.size).toBe(1000);
    });

    it("rejects requests over 10MB with 413", async () => {
      const body = "x".repeat(BODY_LIMITS.LLM + 1);
      const res = await app.request("/test", {
        method: "POST",
        body,
        headers: { "Content-Type": "text/plain" },
      });
      expect(res.status).toBe(413);
      const json = await res.json();
      expect(json.error.code).toBe("request_too_large");
      expect(json.error.type).toBe("invalid_request_error");
      expect(json.error.message).toContain("10MB");
    });
  });

  describe("audioBodyLimit (25MB)", () => {
    const app = buildApp(audioBodyLimit());

    it("allows requests under 25MB", async () => {
      const body = "x".repeat(1000);
      const res = await app.request("/test", {
        method: "POST",
        body,
        headers: { "Content-Type": "application/octet-stream" },
      });
      expect(res.status).toBe(200);
    });

    it("rejects requests over 25MB with 413", async () => {
      const body = "x".repeat(BODY_LIMITS.AUDIO + 1);
      const res = await app.request("/test", {
        method: "POST",
        body,
        headers: { "Content-Type": "application/octet-stream" },
      });
      expect(res.status).toBe(413);
      const json = await res.json();
      expect(json.error.message).toContain("25MB");
    });
  });

  describe("webhookBodyLimit (1MB)", () => {
    const app = buildApp(webhookBodyLimit());

    it("allows requests under 1MB", async () => {
      const body = JSON.stringify({ test: "data" });
      const res = await app.request("/test", {
        method: "POST",
        body,
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(200);
    });

    it("rejects requests over 1MB with 413", async () => {
      const body = "x".repeat(BODY_LIMITS.WEBHOOK + 1);
      const res = await app.request("/test", {
        method: "POST",
        body,
        headers: { "Content-Type": "text/plain" },
      });
      expect(res.status).toBe(413);
      const json = await res.json();
      expect(json.error.message).toContain("1MB");
    });
  });

  describe("error response format", () => {
    const app = buildApp(llmBodyLimit());

    it("returns standard gateway error shape", async () => {
      const body = "x".repeat(BODY_LIMITS.LLM + 1);
      const res = await app.request("/test", {
        method: "POST",
        body,
        headers: { "Content-Type": "text/plain" },
      });
      expect(res.status).toBe(413);
      const json = await res.json();
      expect(json).toEqual({
        error: {
          message: expect.stringContaining("Maximum size"),
          type: "invalid_request_error",
          code: "request_too_large",
        },
      });
    });
  });
});
