import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type FleetEvent, FleetEventEmitter } from "./fleet-event-emitter.js";

vi.mock("../config/logger.js", () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
  },
}));

import { logger } from "../config/logger.js";

describe("FleetEventEmitter", () => {
  let emitter: FleetEventEmitter;
  const event: FleetEvent = {
    type: "bot.started",
    botId: "bot-1",
    tenantId: "tenant-1",
    timestamp: new Date().toISOString(),
  };

  beforeEach(() => {
    emitter = new FleetEventEmitter();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls listeners on emit", () => {
    const listener = vi.fn();
    emitter.subscribe(listener);
    emitter.emit(event);
    expect(listener).toHaveBeenCalledWith(event);
  });

  it("logs listener errors with structured logger", () => {
    const error = new Error("boom");
    emitter.subscribe(() => {
      throw error;
    });
    emitter.emit(event);
    expect(logger.error).toHaveBeenCalledWith("FleetEventEmitter listener error", { err: error });
  });

  it("continues emitting to remaining listeners after one throws", () => {
    const second = vi.fn();
    emitter.subscribe(() => {
      throw new Error("fail");
    });
    emitter.subscribe(second);
    emitter.emit(event);
    expect(second).toHaveBeenCalledWith(event);
  });

  it("unsubscribes correctly", () => {
    const listener = vi.fn();
    const unsub = emitter.subscribe(listener);
    unsub();
    emitter.emit(event);
    expect(listener).not.toHaveBeenCalled();
  });

  it("does not use console.error", () => {
    const spy = vi.spyOn(console, "error");
    emitter.subscribe(() => {
      throw new Error("test");
    });
    emitter.emit(event);
    expect(spy).not.toHaveBeenCalled();
  });
});
