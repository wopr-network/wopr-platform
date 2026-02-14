import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("Process-level error handlers", () => {
  let listeners: Map<string, Function[]>;
  let originalListeners: Map<string, Function[]>;

  beforeEach(() => {
    // Save original process listeners
    originalListeners = new Map();
    listeners = new Map();
    
    ["unhandledRejection", "uncaughtException"].forEach((event) => {
      const original = process.listeners(event);
      originalListeners.set(event, [...original]);
    });
  });

  afterEach(() => {
    // Restore original listeners
    ["unhandledRejection", "uncaughtException"].forEach((event) => {
      process.removeAllListeners(event);
      const original = originalListeners.get(event);
      if (original) {
        original.forEach((listener) => process.on(event, listener as any));
      }
    });
    vi.restoreAllMocks();
  });

  it("registers unhandledRejection handler", () => {
    // The handler is registered in src/index.ts when the module loads
    // We can verify the handler exists by checking process listeners
    const handlers = process.listeners("unhandledRejection");
    expect(handlers.length).toBeGreaterThan(0);
  });

  it("registers uncaughtException handler", () => {
    const handlers = process.listeners("uncaughtException");
    expect(handlers.length).toBeGreaterThan(0);
  });

  it("unhandledRejection handler logs but does not exit", async () => {
    // Import logger to spy on it
    const { logger } = await import("../../src/config/logger.js");
    const loggerSpy = vi.spyOn(logger, "error");
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });

    // Import the REAL handler from index.ts
    const { unhandledRejectionHandler } = await import("../../src/index.js");

    const testError = new Error("Test unhandled rejection");
    const testPromise = Promise.reject(testError);

    // Invoke the real handler
    unhandledRejectionHandler(testError, testPromise);

    expect(loggerSpy).toHaveBeenCalledWith(
      "Unhandled promise rejection",
      expect.objectContaining({
        reason: "Test unhandled rejection",
      }),
    );

    // Verify process.exit was NOT called
    expect(exitSpy).not.toHaveBeenCalled();

    loggerSpy.mockRestore();
    exitSpy.mockRestore();

    // Prevent unhandled rejection from failing the test
    testPromise.catch(() => {});
  });

  it("uncaughtException handler logs and exits immediately", async () => {
    // Import logger module and spy on it FIRST
    const { logger } = await import("../../src/config/logger.js");
    const loggerSpy = vi.spyOn(logger, "error");

    // Mock process.exit
    let exitCalled = false;
    let exitCode = 0;
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number) => {
      exitCalled = true;
      exitCode = code || 0;
      return undefined as never;
    });

    // Import the REAL handler from index.ts
    const { uncaughtExceptionHandler } = await import("../../src/index.js");

    const testError = new Error("Test uncaught exception");

    // Invoke the real handler
    uncaughtExceptionHandler(testError, "uncaughtException");

    // Verify error was logged
    expect(loggerSpy).toHaveBeenCalledWith(
      "Uncaught exception",
      expect.objectContaining({
        error: "Test uncaught exception",
        origin: "uncaughtException",
      }),
    );

    // Verify exit was called immediately with exit code 1
    expect(exitCalled).toBe(true);
    expect(exitCode).toBe(1);

    loggerSpy.mockRestore();
    exitSpy.mockRestore();
  });
});
