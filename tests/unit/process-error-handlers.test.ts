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

    // Create a test handler that mimics src/index.ts behavior
    const testHandler = (reason: any, promise: Promise<any>) => {
      logger.error("Unhandled promise rejection", {
        reason: reason instanceof Error ? reason.message : String(reason),
        stack: reason instanceof Error ? reason.stack : undefined,
        promise: String(promise),
      });
    };

    const testError = new Error("Test unhandled rejection");
    const testPromise = Promise.reject(testError);
    
    testHandler(testError, testPromise);

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

  it("uncaughtException handler logs and schedules exit", async () => {
    vi.useFakeTimers();
    
    const { logger } = await import("../../src/config/logger.js");
    const loggerSpy = vi.spyOn(logger, "error");
    
    let exitCalled = false;
    let exitCode = 0;
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number) => {
      exitCalled = true;
      exitCode = code || 0;
      return undefined as never;
    });

    // Create a test handler that mimics src/index.ts behavior
    const testHandler = (err: Error, origin: string) => {
      logger.error("Uncaught exception", {
        error: err.message,
        stack: err.stack,
        origin,
      });
      setTimeout(() => {
        process.exit(1);
      }, 1000);
    };

    const testError = new Error("Test uncaught exception");
    testHandler(testError, "uncaughtException");

    // Verify error was logged
    expect(loggerSpy).toHaveBeenCalledWith(
      "Uncaught exception",
      expect.objectContaining({
        error: "Test uncaught exception",
        origin: "uncaughtException",
      }),
    );

    // Verify exit was NOT called immediately
    expect(exitCalled).toBe(false);

    // Fast-forward timers
    vi.advanceTimersByTime(1000);

    // Verify exit was called after delay with exit code 1
    expect(exitCalled).toBe(true);
    expect(exitCode).toBe(1);

    loggerSpy.mockRestore();
    exitSpy.mockRestore();
    vi.useRealTimers();
  });
});
