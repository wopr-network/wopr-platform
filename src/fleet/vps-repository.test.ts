import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { DrizzleVpsRepository } from "./vps-repository.js";

describe("DrizzleVpsRepository", () => {
  let db: ReturnType<typeof drizzle>;
  let repo: DrizzleVpsRepository;

  beforeEach(() => {
    const sqlite = new Database(":memory:");
    sqlite.pragma("journal_mode = WAL");
    db = drizzle(sqlite);
    sqlite.exec(`
      CREATE TABLE vps_subscriptions (
        bot_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        stripe_subscription_id TEXT NOT NULL UNIQUE,
        stripe_customer_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        ssh_public_key TEXT,
        cloudflare_tunnel_id TEXT,
        hostname TEXT,
        disk_size_gb INTEGER NOT NULL DEFAULT 20,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_vps_sub_tenant ON vps_subscriptions(tenant_id);
      CREATE INDEX idx_vps_sub_stripe ON vps_subscriptions(stripe_subscription_id);
    `);
    repo = new DrizzleVpsRepository(db as never);
  });

  it("should create and retrieve a VPS subscription", () => {
    repo.create({
      botId: "bot-1",
      tenantId: "tenant-1",
      stripeSubscriptionId: "sub_123",
      stripeCustomerId: "cus_123",
      hostname: "alice.bot.wopr.bot",
    });

    const sub = repo.getByBotId("bot-1");
    expect(sub).not.toBeNull();
    expect(sub?.botId).toBe("bot-1");
    expect(sub?.status).toBe("active");
    expect(sub?.hostname).toBe("alice.bot.wopr.bot");
    expect(sub?.diskSizeGb).toBe(20);
  });

  it("should return null for non-existent bot", () => {
    expect(repo.getByBotId("nope")).toBeNull();
  });

  it("should find by subscription ID", () => {
    repo.create({
      botId: "bot-2",
      tenantId: "tenant-1",
      stripeSubscriptionId: "sub_456",
      stripeCustomerId: "cus_123",
      hostname: "bob.bot.wopr.bot",
    });

    const sub = repo.getBySubscriptionId("sub_456");
    expect(sub).not.toBeNull();
    expect(sub?.botId).toBe("bot-2");
  });

  it("should list by tenant", () => {
    repo.create({
      botId: "bot-1",
      tenantId: "tenant-1",
      stripeSubscriptionId: "sub_1",
      stripeCustomerId: "cus_1",
      hostname: "a.bot.wopr.bot",
    });
    repo.create({
      botId: "bot-2",
      tenantId: "tenant-1",
      stripeSubscriptionId: "sub_2",
      stripeCustomerId: "cus_1",
      hostname: "b.bot.wopr.bot",
    });
    repo.create({
      botId: "bot-3",
      tenantId: "tenant-2",
      stripeSubscriptionId: "sub_3",
      stripeCustomerId: "cus_2",
      hostname: "c.bot.wopr.bot",
    });

    const subs = repo.listByTenant("tenant-1");
    expect(subs).toHaveLength(2);
  });

  it("should update status", () => {
    repo.create({
      botId: "bot-1",
      tenantId: "tenant-1",
      stripeSubscriptionId: "sub_1",
      stripeCustomerId: "cus_1",
      hostname: "a.bot.wopr.bot",
    });

    repo.updateStatus("bot-1", "canceling");
    expect(repo.getByBotId("bot-1")?.status).toBe("canceling");
  });

  it("should delete a subscription", () => {
    repo.create({
      botId: "bot-1",
      tenantId: "tenant-1",
      stripeSubscriptionId: "sub_1",
      stripeCustomerId: "cus_1",
      hostname: "a.bot.wopr.bot",
    });

    repo.delete("bot-1");
    expect(repo.getByBotId("bot-1")).toBeNull();
  });

  it("should set SSH public key", () => {
    repo.create({
      botId: "bot-1",
      tenantId: "tenant-1",
      stripeSubscriptionId: "sub_1",
      stripeCustomerId: "cus_1",
      hostname: "a.bot.wopr.bot",
    });

    repo.setSshPublicKey("bot-1", "ssh-rsa AAAAB3...");
    expect(repo.getByBotId("bot-1")?.sshPublicKey).toBe("ssh-rsa AAAAB3...");
  });

  it("should set tunnel ID", () => {
    repo.create({
      botId: "bot-1",
      tenantId: "tenant-1",
      stripeSubscriptionId: "sub_1",
      stripeCustomerId: "cus_1",
      hostname: "a.bot.wopr.bot",
    });

    repo.setTunnelId("bot-1", "tunnel-abc123");
    expect(repo.getByBotId("bot-1")?.cloudflareTunnelId).toBe("tunnel-abc123");
  });
});
