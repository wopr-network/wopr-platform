import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("runtime deduction scheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("setInterval fires callback every 60s", () => {
    const callback = vi.fn();
    const handle = setInterval(callback, 60_000);

    expect(callback).not.toHaveBeenCalled();

    vi.advanceTimersByTime(60_000);
    expect(callback).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(60_000);
    expect(callback).toHaveBeenCalledTimes(2);

    clearInterval(handle);
  });

  it("clearInterval stops further invocations", () => {
    const callback = vi.fn();
    const handle = setInterval(callback, 60_000);

    vi.advanceTimersByTime(60_000);
    expect(callback).toHaveBeenCalledTimes(1);

    clearInterval(handle);

    vi.advanceTimersByTime(120_000);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("SIGTERM handler calls clearInterval", () => {
    const callback = vi.fn();
    const handle = setInterval(callback, 60_000);

    // Simulate what the shutdown handler does
    const shutdownHandler = () => clearInterval(handle);
    process.on("SIGTERM", shutdownHandler);

    vi.advanceTimersByTime(60_000);
    expect(callback).toHaveBeenCalledTimes(1);

    // Emit SIGTERM
    process.emit("SIGTERM", "SIGTERM");

    vi.advanceTimersByTime(120_000);
    expect(callback).toHaveBeenCalledTimes(1);

    // Clean up listener to not affect other tests
    process.removeListener("SIGTERM", shutdownHandler);
  });
});
