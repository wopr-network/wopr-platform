import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DrizzleDb } from "../db/index.js";
import { createTestDb } from "../test/db.js";
import { DrizzleVpsRepository } from "./vps-repository.js";

describe("DrizzleVpsRepository", () => {
  let db: DrizzleDb;
  let pool: PGlite;
  let repo: DrizzleVpsRepository;

  beforeEach(async () => {
    ({ db, pool } = await createTestDb());
    repo = new DrizzleVpsRepository(db);
  });

  afterEach(async () => {
    await pool.close();
  });

  it("should create and retrieve a VPS subscription", async () => {
    await repo.create({
      botId: "bot-1",
      tenantId: "tenant-1",
      stripeSubscriptionId: "sub_123",
      stripeCustomerId: "cus_123",
      hostname: "alice.bot.wopr.bot",
    });

    const sub = await repo.getByBotId("bot-1");
    expect(sub).not.toBeNull();
    expect(sub?.botId).toBe("bot-1");
    expect(sub?.status).toBe("active");
    expect(sub?.hostname).toBe("alice.bot.wopr.bot");
    expect(sub?.diskSizeGb).toBe(20);
  });

  it("should return null for non-existent bot", async () => {
    expect(await repo.getByBotId("nope")).toBeNull();
  });

  it("should find by subscription ID", async () => {
    await repo.create({
      botId: "bot-2",
      tenantId: "tenant-1",
      stripeSubscriptionId: "sub_456",
      stripeCustomerId: "cus_123",
      hostname: "bob.bot.wopr.bot",
    });

    const sub = await repo.getBySubscriptionId("sub_456");
    expect(sub).not.toBeNull();
    expect(sub?.botId).toBe("bot-2");
  });

  it("should list by tenant", async () => {
    await repo.create({
      botId: "bot-1",
      tenantId: "tenant-1",
      stripeSubscriptionId: "sub_1",
      stripeCustomerId: "cus_1",
      hostname: "a.bot.wopr.bot",
    });
    await repo.create({
      botId: "bot-2",
      tenantId: "tenant-1",
      stripeSubscriptionId: "sub_2",
      stripeCustomerId: "cus_1",
      hostname: "b.bot.wopr.bot",
    });
    await repo.create({
      botId: "bot-3",
      tenantId: "tenant-2",
      stripeSubscriptionId: "sub_3",
      stripeCustomerId: "cus_2",
      hostname: "c.bot.wopr.bot",
    });

    const subs = await repo.listByTenant("tenant-1");
    expect(subs).toHaveLength(2);
  });

  it("should update status", async () => {
    await repo.create({
      botId: "bot-1",
      tenantId: "tenant-1",
      stripeSubscriptionId: "sub_1",
      stripeCustomerId: "cus_1",
      hostname: "a.bot.wopr.bot",
    });

    await repo.updateStatus("bot-1", "canceling");
    expect((await repo.getByBotId("bot-1"))?.status).toBe("canceling");
  });

  it("should delete a subscription", async () => {
    await repo.create({
      botId: "bot-1",
      tenantId: "tenant-1",
      stripeSubscriptionId: "sub_1",
      stripeCustomerId: "cus_1",
      hostname: "a.bot.wopr.bot",
    });

    await repo.delete("bot-1");
    expect(await repo.getByBotId("bot-1")).toBeNull();
  });

  it("should set SSH public key", async () => {
    await repo.create({
      botId: "bot-1",
      tenantId: "tenant-1",
      stripeSubscriptionId: "sub_1",
      stripeCustomerId: "cus_1",
      hostname: "a.bot.wopr.bot",
    });

    await repo.setSshPublicKey("bot-1", "ssh-rsa AAAAB3...");
    expect((await repo.getByBotId("bot-1"))?.sshPublicKey).toBe("ssh-rsa AAAAB3...");
  });

  it("should set tunnel ID", async () => {
    await repo.create({
      botId: "bot-1",
      tenantId: "tenant-1",
      stripeSubscriptionId: "sub_1",
      stripeCustomerId: "cus_1",
      hostname: "a.bot.wopr.bot",
    });

    await repo.setTunnelId("bot-1", "tunnel-abc123");
    expect((await repo.getByBotId("bot-1"))?.cloudflareTunnelId).toBe("tunnel-abc123");
  });
});
