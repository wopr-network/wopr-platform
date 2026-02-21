import { beforeEach, describe, expect, it, vi } from "vitest";
import { RecoveryOrchestrator } from "./recovery-orchestrator.js";

// --- Mock helpers ---

function createMocks() {
  const nodeRepo = {
    getById: vi.fn(),
    transition: vi.fn().mockReturnValue({ id: "dead-node", status: "recovering" }),
    list: vi.fn().mockReturnValue([]),
  };

  const profileRepo = {
    get: vi.fn(),
  };

  const recoveryRepo = {
    createEvent: vi.fn().mockImplementation((data) => ({
      ...data,
      status: "in_progress",
      tenantsRecovered: 0,
      tenantsFailed: 0,
      tenantsWaiting: 0,
      startedAt: Math.floor(Date.now() / 1000),
      completedAt: null,
      reportJson: null,
    })),
    updateEvent: vi.fn(),
    getEvent: vi.fn(),
    createItem: vi.fn().mockImplementation((data) => ({
      ...data,
      targetNode: null,
      status: "waiting",
      reason: null,
      startedAt: null,
      completedAt: null,
    })),
    updateItem: vi.fn(),
    listOpenEvents: vi.fn().mockReturnValue([]),
    getWaitingItems: vi.fn().mockReturnValue([]),
    incrementRetryCount: vi.fn(),
  };

  const commandBus = {
    send: vi.fn().mockResolvedValue({
      id: "cmd-1",
      type: "command_result",
      command: "test",
      success: true,
    }),
  };

  const notifier = {
    nodeRecoveryComplete: vi.fn().mockResolvedValue(undefined),
    capacityOverflow: vi.fn().mockResolvedValue(undefined),
    nodeStatusChange: vi.fn().mockResolvedValue(undefined),
  };

  const getTenants = vi.fn().mockReturnValue([]);
  const findBestTarget = vi.fn().mockReturnValue({
    id: "target-node",
    host: "10.0.0.2",
    status: "active",
    capacityMb: 4096,
    usedMb: 1024,
  });
  const reassignTenant = vi.fn();
  const addNodeCapacity = vi.fn();

  return {
    nodeRepo,
    profileRepo,
    recoveryRepo,
    commandBus,
    notifier,
    getTenants,
    findBestTarget,
    reassignTenant,
    addNodeCapacity,
  };
}

function createOrchestrator(mocks: ReturnType<typeof createMocks>) {
  return new RecoveryOrchestrator(
    // biome-ignore lint/suspicious/noExplicitAny: vi.fn() mocks satisfy the repository interfaces at runtime
    mocks.nodeRepo as any,
    // biome-ignore lint/suspicious/noExplicitAny: vi.fn() mocks satisfy the repository interfaces at runtime
    mocks.profileRepo as any,
    // biome-ignore lint/suspicious/noExplicitAny: vi.fn() mocks satisfy the repository interfaces at runtime
    mocks.recoveryRepo as any,
    // biome-ignore lint/suspicious/noExplicitAny: vi.fn() mocks satisfy the repository interfaces at runtime
    mocks.commandBus as any,
    // biome-ignore lint/suspicious/noExplicitAny: vi.fn() mocks satisfy the AdminNotifier interface at runtime
    mocks.notifier as any,
    mocks.getTenants,
    mocks.findBestTarget,
    mocks.reassignTenant,
    mocks.addNodeCapacity,
  );
}

describe("RecoveryOrchestrator", () => {
  let mocks: ReturnType<typeof createMocks>;
  let orchestrator: RecoveryOrchestrator;

  beforeEach(() => {
    mocks = createMocks();
    orchestrator = createOrchestrator(mocks);
  });

  it("reads image and env from profileRepo.get() instead of hardcoding", async () => {
    // Arrange: tenant with a pinned image and custom env
    const tenant = {
      botId: "bot-1",
      tenantId: "tenant-1",
      name: "my-bot",
      containerName: "tenant_tenant-1",
      estimatedMb: 100,
      tier: "pro",
    };
    mocks.getTenants.mockReturnValue([tenant]);

    mocks.profileRepo.get.mockReturnValue({
      id: "bot-1",
      tenantId: "tenant-1",
      name: "my-bot",
      description: "",
      image: "ghcr.io/wopr-network/wopr:v1.2.3",
      env: { TOKEN: "secret-123", DEBUG: "1" },
      restartPolicy: "unless-stopped",
      releaseChannel: "pinned",
      updatePolicy: "manual",
    });

    // Act
    await orchestrator.triggerRecovery("dead-node", "heartbeat_timeout");

    // Assert: profileRepo.get was called with the bot ID
    expect(mocks.profileRepo.get).toHaveBeenCalledWith("bot-1");

    // Assert: bot.import was called with profile's image and env, NOT defaults
    const importCall = mocks.commandBus.send.mock.calls.find(
      (args) => (args[1] as { type: string }).type === "bot.import",
    );
    expect(importCall).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: guaranteed by toBeDefined() above
    const [_nodeId, importCmd] = importCall!;
    expect(importCmd.payload.image).toBe("ghcr.io/wopr-network/wopr:v1.2.3");
    expect(importCmd.payload.env).toEqual({ TOKEN: "secret-123", DEBUG: "1" });

    // Assert: NOT the hardcoded default
    expect(importCmd.payload.image).not.toBe("ghcr.io/wopr-network/wopr:latest");
  });

  it("transitions dead node unhealthy→offline→recovering, then offline when done", async () => {
    // Arrange: one tenant to recover
    mocks.getTenants.mockReturnValue([
      {
        botId: "bot-1",
        tenantId: "tenant-1",
        name: "my-bot",
        containerName: "tenant_tenant-1",
        estimatedMb: 100,
        tier: "pro",
      },
    ]);
    mocks.profileRepo.get.mockReturnValue(null); // no profile, use defaults

    // Act
    await orchestrator.triggerRecovery("dead-node", "heartbeat_timeout");

    // Assert: three transitions total (unhealthy→offline, offline→recovering, recovering→offline)
    expect(mocks.nodeRepo.transition).toHaveBeenCalledTimes(3);

    // Assert: first transition is to "offline" (unhealthy→offline)
    const firstCall = mocks.nodeRepo.transition.mock.calls[0];
    expect(firstCall[0]).toBe("dead-node");
    expect(firstCall[1]).toBe("offline");
    expect(firstCall[3]).toBe("recovery_orchestrator");

    // Assert: second transition is to "recovering" (offline→recovering)
    const secondCall = mocks.nodeRepo.transition.mock.calls[1];
    expect(secondCall[0]).toBe("dead-node");
    expect(secondCall[1]).toBe("recovering");
    expect(secondCall[3]).toBe("recovery_orchestrator");

    // Assert: third transition is back to "offline" (recovering→offline)
    const thirdCall = mocks.nodeRepo.transition.mock.calls[2];
    expect(thirdCall[0]).toBe("dead-node");
    expect(thirdCall[1]).toBe("offline");
    expect(thirdCall[3]).toBe("recovery_orchestrator");
  });

  it("falls back to default image when no profile found", async () => {
    mocks.getTenants.mockReturnValue([
      {
        botId: "bot-1",
        tenantId: "tenant-1",
        name: "my-bot",
        containerName: "tenant_tenant-1",
        estimatedMb: 100,
        tier: null,
      },
    ]);
    mocks.profileRepo.get.mockReturnValue(null);

    await orchestrator.triggerRecovery("dead-node", "manual");

    const importCall = mocks.commandBus.send.mock.calls.find(
      (args) => (args[1] as { type: string }).type === "bot.import",
    );
    expect(importCall).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: guaranteed by toBeDefined() above
    expect(importCall![1].payload.image).toBe("ghcr.io/wopr-network/wopr:latest");
    // biome-ignore lint/style/noNonNullAssertion: guaranteed by toBeDefined() above
    expect(importCall![1].payload.env).toEqual({});
  });

  it("records tenant as waiting when no target node has capacity", async () => {
    mocks.getTenants.mockReturnValue([
      {
        botId: "bot-1",
        tenantId: "tenant-1",
        name: "my-bot",
        containerName: "tenant_tenant-1",
        estimatedMb: 100,
        tier: null,
      },
    ]);
    mocks.findBestTarget.mockReturnValue(null); // no capacity
    mocks.profileRepo.get.mockReturnValue(null);

    const report = await orchestrator.triggerRecovery("dead-node", "manual");

    expect(report.waiting).toHaveLength(1);
    expect(report.waiting[0].reason).toBe("no_capacity");
    expect(report.recovered).toHaveLength(0);
  });

  it("records tenant as failed when command bus throws", async () => {
    mocks.getTenants.mockReturnValue([
      {
        botId: "bot-1",
        tenantId: "tenant-1",
        name: "my-bot",
        containerName: "tenant_tenant-1",
        estimatedMb: 100,
        tier: null,
      },
    ]);
    mocks.profileRepo.get.mockReturnValue(null);
    mocks.commandBus.send.mockRejectedValueOnce(new Error("connection lost"));

    const report = await orchestrator.triggerRecovery("dead-node", "manual");

    expect(report.failed).toHaveLength(1);
    expect(report.failed[0].reason).toBe("connection lost");
  });

  it("creates recovery event and items via recoveryRepo", async () => {
    mocks.getTenants.mockReturnValue([
      {
        botId: "bot-1",
        tenantId: "tenant-1",
        name: "my-bot",
        containerName: "tenant_tenant-1",
        estimatedMb: 100,
        tier: "pro",
      },
    ]);
    mocks.profileRepo.get.mockReturnValue(null);

    await orchestrator.triggerRecovery("dead-node", "heartbeat_timeout");

    expect(mocks.recoveryRepo.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeId: "dead-node",
        trigger: "heartbeat_timeout",
        tenantsTotal: 1,
      }),
    );
    expect(mocks.recoveryRepo.createItem).toHaveBeenCalledTimes(1);
    expect(mocks.recoveryRepo.updateEvent).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ status: "completed" }),
    );
  });

  it("notifies admin when recovery completes with waiting tenants", async () => {
    mocks.getTenants.mockReturnValue([
      {
        botId: "bot-1",
        tenantId: "tenant-1",
        name: "my-bot",
        containerName: "tenant_tenant-1",
        estimatedMb: 100,
        tier: null,
      },
    ]);
    mocks.findBestTarget.mockReturnValue(null);
    mocks.profileRepo.get.mockReturnValue(null);

    await orchestrator.triggerRecovery("dead-node", "manual");

    expect(mocks.notifier.nodeRecoveryComplete).toHaveBeenCalledWith(
      "dead-node",
      expect.objectContaining({
        waiting: [{ tenant: "bot-1", reason: "no_capacity" }],
      }),
    );
    expect(mocks.notifier.capacityOverflow).toHaveBeenCalledWith("dead-node", 1, 1);
  });

  it("handles multiple tenants, recovering some and failing others", async () => {
    mocks.getTenants.mockReturnValue([
      {
        botId: "bot-1",
        tenantId: "tenant-1",
        name: "bot-one",
        containerName: "tenant_tenant-1",
        estimatedMb: 100,
        tier: "pro",
      },
      {
        botId: "bot-2",
        tenantId: "tenant-2",
        name: "bot-two",
        containerName: "tenant_tenant-2",
        estimatedMb: 100,
        tier: "free",
      },
    ]);
    mocks.profileRepo.get.mockReturnValue(null);
    // First call succeeds, second fails
    mocks.commandBus.send
      .mockResolvedValueOnce({ id: "r1", type: "command_result", command: "backup.download", success: true })
      .mockResolvedValueOnce({ id: "r2", type: "command_result", command: "bot.import", success: true })
      .mockResolvedValueOnce({ id: "r3", type: "command_result", command: "bot.inspect", success: true })
      .mockRejectedValueOnce(new Error("disk full"));

    const report = await orchestrator.triggerRecovery("dead-node", "manual");

    expect(report.recovered).toHaveLength(1);
    expect(report.recovered[0].tenant).toBe("bot-1");
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0].tenant).toBe("bot-2");
  });

  it("retryWaiting recovers previously waiting tenants", async () => {
    const eventId = "event-1";

    mocks.recoveryRepo.getEvent.mockReturnValue({
      id: eventId,
      nodeId: "dead-node",
      trigger: "heartbeat_timeout",
      status: "partial",
      tenantsTotal: 1,
      tenantsRecovered: 0,
      tenantsFailed: 0,
      tenantsWaiting: 1,
      startedAt: Math.floor(Date.now() / 1000),
      completedAt: null,
      reportJson: null,
    });

    mocks.recoveryRepo.getWaitingItems.mockReturnValue([
      {
        id: "item-1",
        recoveryEventId: eventId,
        tenant: "tenant-1",
        sourceNode: "dead-node",
        targetNode: null,
        backupKey: "latest/tenant_tenant-1/latest.tar.gz",
        status: "waiting",
        reason: "no_capacity",
        startedAt: null,
        completedAt: null,
        retryCount: 0,
      },
    ]);

    mocks.getTenants.mockReturnValue([
      {
        botId: "bot-1",
        tenantId: "tenant-1",
        name: "my-bot",
        containerName: "tenant_tenant-1",
        estimatedMb: 100,
        tier: "pro",
      },
    ]);
    mocks.profileRepo.get.mockReturnValue(null);

    const report = await orchestrator.retryWaiting(eventId);

    expect(report.recovered).toHaveLength(1);
    expect(report.recovered[0].tenant).toBe("bot-1");
  });

  it("retryWaiting marks waiting item as failed when recoverTenant fails", async () => {
    const eventId = "event-1";

    mocks.recoveryRepo.getEvent.mockReturnValue({
      id: eventId,
      nodeId: "dead-node",
      trigger: "heartbeat_timeout",
      status: "partial",
      tenantsTotal: 1,
      tenantsRecovered: 0,
      tenantsFailed: 0,
      tenantsWaiting: 1,
      startedAt: Math.floor(Date.now() / 1000),
      completedAt: null,
      reportJson: null,
    });

    mocks.recoveryRepo.getWaitingItems.mockReturnValue([
      {
        id: "item-1",
        recoveryEventId: eventId,
        tenant: "tenant-1",
        sourceNode: "dead-node",
        targetNode: null,
        backupKey: "latest/tenant_tenant-1/latest.tar.gz",
        status: "waiting",
        reason: "no_capacity",
        startedAt: null,
        completedAt: null,
        retryCount: 1,
      },
    ]);

    mocks.getTenants.mockReturnValue([
      {
        botId: "bot-1",
        tenantId: "tenant-1",
        name: "my-bot",
        containerName: "tenant_tenant-1",
        estimatedMb: 100,
        tier: "pro",
      },
    ]);
    mocks.profileRepo.get.mockReturnValue(null);
    // Capacity available now, but the command fails
    mocks.commandBus.send.mockRejectedValueOnce(new Error("connection refused"));

    const report = await orchestrator.retryWaiting(eventId);

    expect(report.failed).toHaveLength(1);
    expect(report.failed[0].tenant).toBe("bot-1");

    // Waiting item must be closed as "failed", not left stuck as "waiting"
    expect(mocks.recoveryRepo.updateItem).toHaveBeenCalledWith("item-1", expect.objectContaining({ status: "failed" }));
  });

  it("retryWaiting throws when event not found", async () => {
    mocks.recoveryRepo.getEvent.mockReturnValue(null);

    await expect(orchestrator.retryWaiting("nonexistent")).rejects.toThrow("Recovery event nonexistent not found");
  });

  it("listEvents delegates to recoveryRepo.listOpenEvents", () => {
    const fakeEvents = [
      {
        id: "evt-1",
        nodeId: "node-1",
        trigger: "manual",
        status: "in_progress",
        tenantsTotal: 2,
        tenantsRecovered: 1,
        tenantsFailed: 0,
        tenantsWaiting: 1,
        startedAt: 1000,
        completedAt: null,
        reportJson: null,
      },
    ];
    mocks.recoveryRepo.listOpenEvents.mockReturnValue(fakeEvents);

    const result = orchestrator.listEvents();

    expect(result).toEqual(fakeEvents);
    expect(mocks.recoveryRepo.listOpenEvents).toHaveBeenCalled();
  });

  it("getEventDetails returns event and waiting items", () => {
    const event = {
      id: "evt-1",
      nodeId: "node-1",
      trigger: "manual",
      status: "in_progress",
      tenantsTotal: 1,
      tenantsRecovered: 0,
      tenantsFailed: 0,
      tenantsWaiting: 1,
      startedAt: 1000,
      completedAt: null,
      reportJson: null,
    };
    const items = [
      {
        id: "item-1",
        recoveryEventId: "evt-1",
        tenant: "tenant-1",
        sourceNode: "node-1",
        targetNode: null,
        backupKey: null,
        status: "waiting",
        reason: "no_capacity",
        startedAt: null,
        completedAt: null,
        retryCount: 0,
      },
    ];
    mocks.recoveryRepo.getEvent.mockReturnValue(event);
    mocks.recoveryRepo.getWaitingItems.mockReturnValue(items);

    const result = orchestrator.getEventDetails("evt-1");

    expect(result.event).toEqual(event);
    expect(result.items).toEqual(items);
  });
});
