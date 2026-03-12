import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DrizzleDb } from "@wopr-network/platform-core/db/index";
import { createTestDb } from "@wopr-network/platform-core/test/db";
import { DrizzleBotInstanceRepository } from "@wopr-network/platform-core/fleet/drizzle-bot-instance-repository";
import { DrizzleNodeRepository } from "@wopr-network/platform-core/fleet/drizzle-node-repository";
import { DrizzleRegistrationTokenRepository } from "@wopr-network/platform-core/fleet/registration-token-store";
import { HeartbeatWatchdog } from "@wopr-network/platform-core/fleet/heartbeat-watchdog";
import type { INodeRepository } from "@wopr-network/platform-core/fleet/node-repository";

describe("E2E: node agent registration → heartbeat → fleet bot assignment", () => {
  let db: DrizzleDb;
  let pool: PGlite;
  let nodeRepo: DrizzleNodeRepository;
  let botRepo: DrizzleBotInstanceRepository;
  let tokenRepo: DrizzleRegistrationTokenRepository;

  // Unique IDs per test file run (tests share a fresh DB each time)
  const suffix = crypto.randomUUID();
  const NODE_ID = `node-e2e-${suffix}`;
  const TENANT_ID = `tenant-e2e-${suffix}`;
  const BOT_ID = `bot-e2e-${suffix}`;
  const USER_ID = `user-e2e-${suffix}`;

  beforeEach(async () => {
    // Each test gets a fresh PGlite database (migrated from snapshot)
    ({ db, pool } = await createTestDb());
    nodeRepo = new DrizzleNodeRepository(db);
    botRepo = new DrizzleBotInstanceRepository(db);
    tokenRepo = new DrizzleRegistrationTokenRepository(db);
  });

  afterEach(async () => {
    await pool.close();
  });

  it("seed token → register node → node is active", async () => {
    const { token, expiresAt } = await tokenRepo.create(USER_ID, "e2e-test-node");
    expect(token).toBeTruthy();
    expect(expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));

    const consumed = await tokenRepo.consume(token, NODE_ID);
    expect(consumed).not.toBeNull();
    expect(consumed!.userId).toBe(USER_ID);
    expect(consumed!.label).toBe("e2e-test-node");

    const node = await nodeRepo.register({
      nodeId: NODE_ID,
      host: "192.168.1.100",
      capacityMb: 8192,
      agentVersion: "1.0.0",
    });

    expect(node.id).toBe(NODE_ID);
    expect(node.status).toBe("active");

    const transitions = await nodeRepo.listTransitions(NODE_ID);
    expect(transitions).toHaveLength(1);
    expect(transitions[0].fromStatus).toBe("provisioning");
    expect(transitions[0].toStatus).toBe("active");
    expect(transitions[0].reason).toBe("first_registration");
  });

  it("heartbeat updates keep node active", async () => {
    await nodeRepo.register({
      nodeId: NODE_ID,
      host: "192.168.1.100",
      capacityMb: 8192,
      agentVersion: "1.0.0",
    });

    await nodeRepo.updateHeartbeat(NODE_ID, 500);

    const node = await nodeRepo.getById(NODE_ID);
    expect(node).not.toBeNull();
    expect(node!.usedMb).toBe(500);
    expect(node!.lastHeartbeatAt).not.toBeNull();
    expect(node!.status).toBe("active");
  });

  it("bot created and assigned to active node", async () => {
    await nodeRepo.register({
      nodeId: NODE_ID,
      host: "192.168.1.100",
      capacityMb: 8192,
      agentVersion: "1.0.0",
    });

    const bot = await botRepo.create({
      id: BOT_ID,
      tenantId: TENANT_ID,
      name: "e2e-test-bot",
      nodeId: NODE_ID,
    });

    expect(bot.id).toBe(BOT_ID);
    expect(bot.nodeId).toBe(NODE_ID);
    expect(bot.billingState).toBe("active");

    const nodeBots = await botRepo.listByNode(NODE_ID);
    expect(nodeBots).toHaveLength(1);
    expect(nodeBots[0].id).toBe(BOT_ID);
  });

  it("missed heartbeats → node offline → bot unassigned", async () => {
    const baseNow = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(baseNow);

    const onRecovery = vi.fn();
    const onStatusChange = vi.fn();
    const watchdog = new HeartbeatWatchdog(
      nodeRepo as INodeRepository,
      onRecovery,
      onStatusChange,
      {
        unhealthyThresholdS: 90,
        offlineThresholdS: 300,
        checkIntervalMs: 1000,
      },
    );

    try {
      const registered = await nodeRepo.register({
        nodeId: NODE_ID,
        host: "192.168.1.100",
        capacityMb: 8192,
        agentVersion: "1.0.0",
      });
      expect(registered.status).toBe("active");

      await nodeRepo.updateHeartbeat(NODE_ID, 200);

      await botRepo.create({
        id: BOT_ID,
        tenantId: TENANT_ID,
        name: "e2e-test-bot",
        nodeId: NODE_ID,
      });

      const botsBefore = await botRepo.listByNode(NODE_ID);
      expect(botsBefore).toHaveLength(1);

      watchdog.start();

      // Advance past unhealthy threshold (90s from baseNow)
      vi.setSystemTime(baseNow + 100_000);
      await vi.advanceTimersByTimeAsync(1000);

      const nodeAfterUnhealthy = await nodeRepo.getById(NODE_ID);
      expect(nodeAfterUnhealthy!.status).toBe("unhealthy");
      expect(onStatusChange).toHaveBeenCalledWith(NODE_ID, "unhealthy");
      expect(onRecovery).not.toHaveBeenCalled();

      // Advance past offline threshold (300s total from baseNow)
      vi.setSystemTime(baseNow + 310_000);
      await vi.advanceTimersByTimeAsync(1000);

      const nodeAfterOffline = await nodeRepo.getById(NODE_ID);
      expect(nodeAfterOffline!.status).toBe("offline");
      expect(onStatusChange).toHaveBeenCalledWith(NODE_ID, "offline");
      expect(onRecovery).toHaveBeenCalledWith(NODE_ID);

      // Simulate recovery: unassign bots from offline node
      await botRepo.reassign(BOT_ID, null);

      const botAfter = await botRepo.getById(BOT_ID);
      expect(botAfter!.nodeId).toBeNull();

      const botsOnNode = await botRepo.listByNode(NODE_ID);
      expect(botsOnNode).toHaveLength(0);

      const transitions = await nodeRepo.listTransitions(NODE_ID);
      const statuses = transitions.map((t) => `${t.fromStatus}→${t.toStatus}`);
      expect(statuses).toContain("active→unhealthy");
      expect(statuses).toContain("unhealthy→offline");
      expect(statuses).toContain("provisioning→active");
    } finally {
      watchdog.stop();
      vi.useRealTimers();
    }
  });
});
