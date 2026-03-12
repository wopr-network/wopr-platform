import { config } from "@wopr-network/platform-core/config/index";
import { logger } from "@wopr-network/platform-core/config/logger";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { app, errorHandler } from "./app.js";

describe("Global error handler", () => {
  let _savedNodeEnv: string | undefined;

  afterEach(() => {
    if (_savedNodeEnv !== undefined) {
      Object.defineProperty(config, "nodeEnv", { value: _savedNodeEnv, writable: true, configurable: true });
      _savedNodeEnv = undefined;
    }
  });
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

  it("main app has error handler configured", async () => {
    // Hit a route that doesn't exist — the real app's notFound handler should respond
    const res = await app.request("/this-route-does-not-exist-12345");
    expect(res.status).toBe(404);
  });

  it("logs stack at warn level in production", async () => {
    _savedNodeEnv = config.nodeEnv;
    Object.defineProperty(config, "nodeEnv", { value: "production", writable: true, configurable: true });

    const errorSpy = vi.spyOn(logger, "error");
    const warnSpy = vi.spyOn(logger, "warn");

    const testApp = new Hono();
    testApp.get("/test-prod-stack", () => {
      throw new Error("Production error");
    });
    testApp.onError(errorHandler);

    await testApp.request("/test-prod-stack");

    // error-level log should NOT contain stack
    expect(errorSpy).toHaveBeenCalledWith(
      "Unhandled error in request",
      expect.objectContaining({
        error: "Production error",
        path: "/test-prod-stack",
        method: "GET",
      }),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      "Unhandled error in request",
      expect.not.objectContaining({ stack: expect.anything() }),
    );

    // stack should be logged at warn level with method field
    expect(warnSpy).toHaveBeenCalledWith(
      "Error stack trace (debug)",
      expect.objectContaining({
        stack: expect.any(String),
        path: "/test-prod-stack",
        method: "GET",
      }),
    );

    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("logs stack at error level in development", async () => {
    _savedNodeEnv = config.nodeEnv;
    Object.defineProperty(config, "nodeEnv", { value: "development", writable: true, configurable: true });

    const errorSpy = vi.spyOn(logger, "error");
    const warnSpy = vi.spyOn(logger, "warn");

    const testApp = new Hono();
    testApp.get("/test-dev-stack", () => {
      throw new Error("Dev error");
    });
    testApp.onError(errorHandler);

    await testApp.request("/test-dev-stack");

    // error-level log SHOULD contain stack in dev
    expect(errorSpy).toHaveBeenCalledWith(
      "Unhandled error in request",
      expect.objectContaining({
        error: "Dev error",
        stack: expect.any(String),
        path: "/test-dev-stack",
        method: "GET",
      }),
    );

    // warn should NOT be called for stack in dev
    expect(warnSpy).not.toHaveBeenCalled();

    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });
});
