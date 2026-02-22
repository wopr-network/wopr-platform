import { describe, expect, it, vi } from "vitest";
import type { NodeRegistrarNodeRepo, NodeRegistrarRecoveryRepo } from "./node-registrar.js";
import { NodeRegistrar } from "./node-registrar.js";
import type { Node, NodeRegistration, RecoveryEvent } from "./repository-types.js";

function makeNode(overrides: Partial<Node> = {}): Node {
  return {
    id: "node-1",
    host: "10.0.0.1",
    status: "active",
    capacityMb: 8192,
    usedMb: 0,
    agentVersion: "1.0.0",
    lastHeartbeatAt: null,
    registeredAt: 1000,
    updatedAt: 1000,
    dropletId: null,
    region: null,
    size: null,
    monthlyCostCents: null,
    provisionStage: null,
    lastError: null,
    drainStatus: null,
    drainMigrated: null,
    drainTotal: null,
    ownerUserId: null,
    nodeSecret: null,
    label: null,
    ...overrides,
  };
}

function makeRegistration(overrides: Partial<NodeRegistration> = {}): NodeRegistration {
  return {
    nodeId: "node-1",
    host: "10.0.0.1",
    capacityMb: 8192,
    agentVersion: "1.0.0",
    ...overrides,
  };
}

function makeRecoveryEvent(overrides: Partial<RecoveryEvent> = {}): RecoveryEvent {
  return {
    id: "evt-1",
    nodeId: "node-dead",
    trigger: "heartbeat_timeout",
    status: "partial",
    tenantsTotal: 3,
    tenantsRecovered: 1,
    tenantsFailed: 0,
    tenantsWaiting: 2,
    startedAt: 1000,
    completedAt: null,
    reportJson: null,
    ...overrides,
  };
}

describe("NodeRegistrar", () => {
  it("calls nodeRepo.register and returns result", () => {
    const node = makeNode({ id: "node-1", status: "active" });
    const nodeRepo: NodeRegistrarNodeRepo = {
      register: vi.fn().mockReturnValue(node),
      registerSelfHosted: vi.fn().mockReturnValue(node),
    };
    const recoveryRepo: NodeRegistrarRecoveryRepo = {
      listOpenEvents: vi.fn().mockReturnValue([]),
      getWaitingItems: vi.fn(),
    };

    const registrar = new NodeRegistrar(nodeRepo, recoveryRepo);
    const reg = makeRegistration({ nodeId: "node-1" });
    const result = registrar.register(reg);

    expect(nodeRepo.register).toHaveBeenCalledWith(reg);
    expect(result).toBe(node);
  });

  it("triggers onReturning callback when node status is returning", () => {
    const node = makeNode({ id: "node-1", status: "returning" });
    const nodeRepo: NodeRegistrarNodeRepo = {
      register: vi.fn().mockReturnValue(node),
      registerSelfHosted: vi.fn().mockReturnValue(node),
    };
    const recoveryRepo: NodeRegistrarRecoveryRepo = {
      listOpenEvents: vi.fn().mockReturnValue([]),
      getWaitingItems: vi.fn(),
    };
    const onReturning = vi.fn();

    const registrar = new NodeRegistrar(nodeRepo, recoveryRepo, { onReturning });
    registrar.register(makeRegistration({ nodeId: "node-1" }));

    expect(onReturning).toHaveBeenCalledWith("node-1");
  });

  it("triggers onRetryWaiting when there are waiting tenants after registration", () => {
    const node = makeNode({ id: "node-1", status: "active" });
    const event = makeRecoveryEvent({ id: "evt-1" });
    const waitingItem = {
      id: "item-1",
      recoveryEventId: "evt-1",
      tenant: "tenant-abc",
      sourceNode: "node-dead",
      targetNode: null,
      backupKey: null,
      status: "waiting" as const,
      reason: "no_capacity",
      startedAt: 1000,
      completedAt: null,
    };

    const nodeRepo: NodeRegistrarNodeRepo = {
      register: vi.fn().mockReturnValue(node),
      registerSelfHosted: vi.fn().mockReturnValue(node),
    };
    const recoveryRepo: NodeRegistrarRecoveryRepo = {
      listOpenEvents: vi.fn().mockReturnValue([event]),
      getWaitingItems: vi.fn().mockReturnValue([waitingItem]),
    };
    const onRetryWaiting = vi.fn();

    const registrar = new NodeRegistrar(nodeRepo, recoveryRepo, { onRetryWaiting });
    registrar.register(makeRegistration({ nodeId: "node-1" }));

    expect(recoveryRepo.listOpenEvents).toHaveBeenCalled();
    expect(recoveryRepo.getWaitingItems).toHaveBeenCalledWith("evt-1");
    expect(onRetryWaiting).toHaveBeenCalledWith("evt-1");
  });

  it("triggers onRetryWaiting for waiting tenants even when onReturning is a no-op (returning node)", () => {
    // Regression guard for WOP-912: onReturning is wired as a no-op in services.ts
    // because OrphanCleaner handles container cleanup on first heartbeat.
    // The waiting-tenant retry is handled separately by the onRetryWaiting path,
    // which fires for ALL registrations regardless of node status. This test
    // verifies that a no-op onReturning does not suppress the retry.
    const node = makeNode({ id: "node-1", status: "returning" });
    const event = makeRecoveryEvent({ id: "evt-1" });
    const waitingItem = {
      id: "item-1",
      recoveryEventId: "evt-1",
      tenant: "tenant-abc",
      sourceNode: "node-dead",
      targetNode: null,
      backupKey: null,
      status: "waiting" as const,
      reason: "no_capacity",
      startedAt: 1000,
      completedAt: null,
    };

    const nodeRepo: NodeRegistrarNodeRepo = {
      register: vi.fn().mockReturnValue(node),
      registerSelfHosted: vi.fn().mockReturnValue(node),
    };
    const recoveryRepo: NodeRegistrarRecoveryRepo = {
      listOpenEvents: vi.fn().mockReturnValue([event]),
      getWaitingItems: vi.fn().mockReturnValue([waitingItem]),
    };
    // Simulate services.ts wiring: onReturning is a no-op, onRetryWaiting is active
    const onReturning = vi.fn(); // no-op stand-in
    const onRetryWaiting = vi.fn();

    const registrar = new NodeRegistrar(nodeRepo, recoveryRepo, { onReturning, onRetryWaiting });
    registrar.register(makeRegistration({ nodeId: "node-1" }));

    // onReturning fires for node lifecycle (container cleanup hand-off)
    expect(onReturning).toHaveBeenCalledWith("node-1");
    // onRetryWaiting fires independently — waiting tenants get placed regardless
    expect(onRetryWaiting).toHaveBeenCalledWith("evt-1");
  });
});
