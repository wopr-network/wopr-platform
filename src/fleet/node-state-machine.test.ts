import { describe, expect, it } from "vitest";
import {
  ConcurrentTransitionError,
  InvalidTransitionError,
  isValidTransition,
  NODE_STATUSES,
  NodeNotFoundError,
  VALID_TRANSITIONS,
} from "./node-state-machine.js";

describe("NODE_STATUSES", () => {
  it("contains exactly 8 statuses", () => {
    expect(NODE_STATUSES).toHaveLength(8);
  });

  it("includes all expected statuses", () => {
    const expected = [
      "provisioning",
      "active",
      "unhealthy",
      "offline",
      "recovering",
      "returning",
      "draining",
      "failed",
    ];
    for (const s of expected) {
      expect(NODE_STATUSES).toContain(s);
    }
  });
});

describe("VALID_TRANSITIONS", () => {
  it("has an entry for every status", () => {
    for (const status of NODE_STATUSES) {
      expect(VALID_TRANSITIONS).toHaveProperty(status);
    }
  });

  it("has no extra keys beyond NODE_STATUSES", () => {
    const keys = Object.keys(VALID_TRANSITIONS);
    expect(keys).toHaveLength(NODE_STATUSES.length);
    for (const key of keys) {
      expect(NODE_STATUSES).toContain(key);
    }
  });

  it("only contains valid statuses as targets", () => {
    for (const [_from, targets] of Object.entries(VALID_TRANSITIONS)) {
      for (const to of targets) {
        expect(NODE_STATUSES).toContain(to);
      }
    }
  });
});

describe("isValidTransition — allowed transitions", () => {
  it("allows provisioning → active", () => {
    expect(isValidTransition("provisioning", "active")).toBe(true);
  });

  it("allows provisioning → failed", () => {
    expect(isValidTransition("provisioning", "failed")).toBe(true);
  });

  it("allows active → unhealthy", () => {
    expect(isValidTransition("active", "unhealthy")).toBe(true);
  });

  it("allows active → draining", () => {
    expect(isValidTransition("active", "draining")).toBe(true);
  });

  it("allows unhealthy → active (heartbeat recovery)", () => {
    expect(isValidTransition("unhealthy", "active")).toBe(true);
  });

  it("allows unhealthy → offline", () => {
    expect(isValidTransition("unhealthy", "offline")).toBe(true);
  });

  it("allows offline → recovering", () => {
    expect(isValidTransition("offline", "recovering")).toBe(true);
  });

  it("allows offline → returning (node rebooted while offline)", () => {
    expect(isValidTransition("offline", "returning")).toBe(true);
  });

  it("allows recovering → offline (recovery done, node still gone)", () => {
    expect(isValidTransition("recovering", "offline")).toBe(true);
  });

  it("allows recovering → returning (node rebooted mid-recovery)", () => {
    expect(isValidTransition("recovering", "returning")).toBe(true);
  });

  it("allows returning → active (orphan cleanup done)", () => {
    expect(isValidTransition("returning", "active")).toBe(true);
  });

  it("allows returning → failed (cleanup timeout)", () => {
    expect(isValidTransition("returning", "failed")).toBe(true);
  });

  it("allows draining → offline", () => {
    expect(isValidTransition("draining", "offline")).toBe(true);
  });

  it("allows failed → returning (node re-registers)", () => {
    expect(isValidTransition("failed", "returning")).toBe(true);
  });
});

describe("isValidTransition — blocked transitions", () => {
  it("blocks active → offline (must go via unhealthy)", () => {
    expect(isValidTransition("active", "offline")).toBe(false);
  });

  it("blocks offline → active (must go via returning)", () => {
    expect(isValidTransition("offline", "active")).toBe(false);
  });

  it("blocks returning → recovering", () => {
    expect(isValidTransition("returning", "recovering")).toBe(false);
  });

  it("blocks failed → active (must go via returning)", () => {
    expect(isValidTransition("failed", "active")).toBe(false);
  });

  it("blocks self-transitions (no status can transition to itself)", () => {
    for (const status of NODE_STATUSES) {
      expect(isValidTransition(status, status)).toBe(false);
    }
  });

  it("blocks provisioning → unhealthy", () => {
    expect(isValidTransition("provisioning", "unhealthy")).toBe(false);
  });

  it("blocks draining → active", () => {
    expect(isValidTransition("draining", "active")).toBe(false);
  });
});

describe("InvalidTransitionError", () => {
  it("includes from and to statuses in message", () => {
    const err = new InvalidTransitionError("active", "provisioning");
    expect(err.message).toContain("active");
    expect(err.message).toContain("provisioning");
  });

  it("has name InvalidTransitionError", () => {
    const err = new InvalidTransitionError("active", "provisioning");
    expect(err.name).toBe("InvalidTransitionError");
  });

  it("is an instance of Error", () => {
    const err = new InvalidTransitionError("active", "provisioning");
    expect(err).toBeInstanceOf(Error);
  });
});

describe("ConcurrentTransitionError", () => {
  it("includes node ID in message", () => {
    const err = new ConcurrentTransitionError("node-42");
    expect(err.message).toContain("node-42");
  });

  it("has name ConcurrentTransitionError", () => {
    const err = new ConcurrentTransitionError("node-42");
    expect(err.name).toBe("ConcurrentTransitionError");
  });

  it("is an instance of Error", () => {
    const err = new ConcurrentTransitionError("node-42");
    expect(err).toBeInstanceOf(Error);
  });
});

describe("NodeNotFoundError", () => {
  it("includes node ID in message", () => {
    const err = new NodeNotFoundError("node-99");
    expect(err.message).toContain("node-99");
  });

  it("has name NodeNotFoundError", () => {
    const err = new NodeNotFoundError("node-99");
    expect(err.name).toBe("NodeNotFoundError");
  });

  it("is an instance of Error", () => {
    const err = new NodeNotFoundError("node-99");
    expect(err).toBeInstanceOf(Error);
  });
});
