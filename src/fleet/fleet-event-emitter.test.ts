import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type FleetEvent, FleetEventEmitter } from "./fleet-event-emitter.js";
import type { IFleetEventRepository } from "./fleet-event-repository.js";

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

  it("emits node lifecycle events", () => {
    const listener = vi.fn();
    emitter.subscribe(listener);
    const nodeEvent: FleetEvent = {
      type: "node.provisioned",
      nodeId: "node-1",
      timestamp: new Date().toISOString(),
    };
    emitter.emit(nodeEvent);
    expect(listener).toHaveBeenCalledWith(nodeEvent);
  });

  it("does not use console.error", () => {
    const spy = vi.spyOn(console, "error");
    emitter.subscribe(() => {
      throw new Error("test");
    });
    emitter.emit(event);
    expect(spy).not.toHaveBeenCalled();
  });

  it("persists bot events via repository when provided", () => {
    const mockRepo = {
      fireFleetStop: vi.fn(),
      clearFleetStop: vi.fn(),
      isFleetStopFired: vi.fn(),
      append: vi.fn().mockResolvedValue(undefined),
      list: vi.fn(),
    } satisfies IFleetEventRepository;

    const persistingEmitter = new FleetEventEmitter(mockRepo);
    persistingEmitter.emit(event);
    expect(mockRepo.append).toHaveBeenCalledWith({
      eventType: event.type,
      botId: (event as { botId: string }).botId,
      tenantId: (event as { tenantId: string }).tenantId,
      createdAt: expect.any(Number),
    });
  });

  it("does not persist node events via repository", () => {
    const mockRepo = {
      fireFleetStop: vi.fn(),
      clearFleetStop: vi.fn(),
      isFleetStopFired: vi.fn(),
      append: vi.fn().mockResolvedValue(undefined),
      list: vi.fn(),
    } satisfies IFleetEventRepository;

    const persistingEmitter = new FleetEventEmitter(mockRepo);
    const nodeEvent: FleetEvent = {
      type: "node.provisioned",
      nodeId: "node-1",
      timestamp: new Date().toISOString(),
    };
    persistingEmitter.emit(nodeEvent);
    expect(mockRepo.append).not.toHaveBeenCalled();
  });

  it("does not throw when repository append fails", () => {
    const mockRepo = {
      fireFleetStop: vi.fn(),
      clearFleetStop: vi.fn(),
      isFleetStopFired: vi.fn(),
      append: vi.fn().mockRejectedValue(new Error("db down")),
      list: vi.fn(),
    } satisfies IFleetEventRepository;

    const persistingEmitter = new FleetEventEmitter(mockRepo);
    expect(() => persistingEmitter.emit(event)).not.toThrow();
  });

  it("works without repository (backward compatible)", () => {
    const listener = vi.fn();
    emitter.subscribe(listener);
    emitter.emit(event);
    expect(listener).toHaveBeenCalledWith(event);
  });
});
