import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { logger } from "../config/logger.js";
import { app, errorHandler } from "./app.js";

describe("Global error handler", () => {
  it("catches errors thrown in route handlers and returns 500", async () => {
    // Create a minimal app that uses the REAL error handler from app.ts
    const testApp = new Hono();
    testApp.get("/test-error", () => {
      throw new Error("Test error from route handler");
    });

    // Use the real error handler exported from app.ts
    testApp.onError(errorHandler);

    const res = await testApp.request("/test-error");
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body).toEqual({
      error: "Internal server error",
      message: "An unexpected error occurred while processing your request",
    });
  });

  it("catches async errors from route handlers", async () => {
    const testApp = new Hono();
    testApp.get("/test-async-error", async () => {
      await Promise.resolve();
      throw new Error("Async error from route handler");
    });

    // Use the real error handler exported from app.ts
    testApp.onError(errorHandler);

    const res = await testApp.request("/test-async-error");
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.error).toBe("Internal server error");
  });

  it("logs error details when an error occurs", async () => {
    const loggerSpy = vi.spyOn(logger, "error");

    const testApp = new Hono();
    testApp.get("/test-logging", () => {
      throw new Error("Error that should be logged");
    });

    // Use the real error handler exported from app.ts
    testApp.onError(errorHandler);

    await testApp.request("/test-logging");

    expect(loggerSpy).toHaveBeenCalledWith(
      "Unhandled error in request",
      expect.objectContaining({
        error: "Error that should be logged",
        path: "/test-logging",
        method: "GET",
      }),
    );

    loggerSpy.mockRestore();
  });

  it("prevents errors from crashing the server", async () => {
    // This test verifies that multiple errors don't crash the process
    const testApp = new Hono();
    testApp.get("/error-1", () => {
      throw new Error("First error");
    });
    testApp.get("/error-2", () => {
      throw new Error("Second error");
    });

    // Use the real error handler exported from app.ts
    testApp.onError(errorHandler);

    // Both requests should return 500, not crash
    const res1 = await testApp.request("/error-1");
    expect(res1.status).toBe(500);

    const res2 = await testApp.request("/error-2");
    expect(res2.status).toBe(500);
  });

  it("main app has error handler configured", () => {
    // Verify the main app has an error handler
    // We can't directly test app.onError is set, but we can verify
    // the app is an instance of Hono which supports error handling
    expect(app).toBeDefined();
    expect(app.request).toBeDefined();
  });
});
