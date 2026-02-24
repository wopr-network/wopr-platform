import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const vpsSubscriptions = sqliteTable(
  "vps_subscriptions",
  {
    /** Bot instance UUID (FK to bot_instances.id) */
    botId: text("bot_id").primaryKey(),
    /** Owning tenant ID */
    tenantId: text("tenant_id").notNull(),
    /** Stripe subscription ID (sub_xxx) */
    stripeSubscriptionId: text("stripe_subscription_id").notNull().unique(),
    /** Stripe customer ID */
    stripeCustomerId: text("stripe_customer_id").notNull(),
    /** VPS status: active, canceling, canceled */
    status: text("status").notNull().default("active"),
    /** SSH public key stored for the container */
    sshPublicKey: text("ssh_public_key"),
    /** Cloudflare tunnel ID for SSH proxy */
    cloudflareTunnelId: text("cloudflare_tunnel_id"),
    /** Dedicated hostname (e.g., username.bot.wopr.bot) */
    hostname: text("hostname"),
    /** Disk size in GB */
    diskSizeGb: integer("disk_size_gb").notNull().default(20),
    createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
    updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    index("idx_vps_sub_tenant").on(table.tenantId),
    index("idx_vps_sub_stripe").on(table.stripeSubscriptionId),
  ],
);
