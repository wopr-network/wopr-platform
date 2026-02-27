import { sql } from "drizzle-orm";
import { boolean, index, integer, pgTable, real, text, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * Sell rates — what users pay. This is the public-facing price list.
 * Completely decoupled from provider costs.
 */
export const sellRates = pgTable(
  "sell_rates",
  {
    id: text("id").primaryKey(),
    /** Capability: "tts", "text-generation", "transcription", "image-generation", "embeddings" */
    capability: text("capability").notNull(),
    /** Human-readable model/service name (e.g., "Claude Sonnet 4.5", "Text-to-Speech") */
    displayName: text("display_name").notNull(),
    /** Billing unit description (e.g., "1M input tokens", "1K characters", "image", "minute") */
    unit: text("unit").notNull(),
    /** Price per unit in USD */
    priceUsd: real("price_usd").notNull(),
    /** Optional model identifier for routing (e.g., "anthropic/claude-sonnet-4.5") */
    model: text("model"),
    /** Whether this rate is active (visible on pricing page) */
    isActive: boolean("is_active").notNull().default(true),
    /** Sort order within capability group */
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: text("created_at").notNull().default(sql`(now())`),
    updatedAt: text("updated_at").notNull().default(sql`(now())`),
  },
  (table) => [
    index("idx_sell_rates_capability").on(table.capability),
    index("idx_sell_rates_active").on(table.isActive),
    uniqueIndex("idx_sell_rates_cap_model").on(table.capability, table.model),
  ],
);

/**
 * Provider costs — what we pay upstream providers.
 * Multiple providers can serve the same capability; priority + latency class
 * feed the provider arbitrage router.
 */
export const providerCosts = pgTable(
  "provider_costs",
  {
    id: text("id").primaryKey(),
    /** Capability this provider serves */
    capability: text("capability").notNull(),
    /** Provider/adapter name (e.g., "openrouter", "chatterbox-tts", "elevenlabs") */
    adapter: text("adapter").notNull(),
    /** Optional model identifier (e.g., "anthropic/claude-sonnet-4.5") */
    model: text("model"),
    /** Billing unit (must match sell_rates unit for same capability) */
    unit: text("unit").notNull(),
    /** Wholesale cost per unit in USD */
    costUsd: real("cost_usd").notNull(),
    /** Routing priority (lower = preferred). Used by arbitrage router. */
    priority: integer("priority").notNull().default(0),
    /** Latency class: "fast", "standard", "batch" */
    latencyClass: text("latency_class").notNull().default("standard"),
    /** Whether this provider is active and eligible for routing */
    isActive: boolean("is_active").notNull().default(true),
    createdAt: text("created_at").notNull().default(sql`(now())`),
    updatedAt: text("updated_at").notNull().default(sql`(now())`),
  },
  (table) => [
    index("idx_provider_costs_capability").on(table.capability),
    index("idx_provider_costs_adapter").on(table.adapter),
    index("idx_provider_costs_active").on(table.isActive),
    uniqueIndex("idx_provider_costs_cap_adapter_model").on(table.capability, table.adapter, table.model),
  ],
);
