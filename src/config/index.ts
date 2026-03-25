/**
 * wopr-platform config extension.
 *
 * Re-exports everything from platform-core's config, plus wopr-platform-specific
 * sections (discovery, pagerduty, dht) that don't belong in the shared core.
 */
import { config as coreConfig } from "@wopr-network/platform-core/config/index";
import { z } from "zod";

const discoverySchema = z
  .object({
    defaultTopic: z.string().min(1).default("wopr-service"),
  })
  .default({ defaultTopic: "wopr-service" });

const pagerdutySchema = z
  .object({
    enabled: z.coerce.boolean().default(false),
    routingKey: z.string().default(""),
    afterHoursRoutingKey: z.string().optional(),
    businessHoursStart: z.coerce.number().int().min(0).max(23).default(14),
    businessHoursEnd: z.coerce.number().int().min(0).max(23).default(23),
  })
  .default({
    enabled: false,
    routingKey: "",
    businessHoursStart: 14,
    businessHoursEnd: 23,
  });

const platformExtras = z
  .object({
    discovery: discoverySchema,
    pagerduty: pagerdutySchema,
    productSlug: z.string().default("wopr"),
  })
  .parse({
    discovery: { defaultTopic: process.env.DISCOVERY_DEFAULT_TOPIC },
    productSlug: process.env.PRODUCT_SLUG,
    pagerduty: {
      enabled: process.env.PAGERDUTY_ENABLED,
      routingKey: process.env.PAGERDUTY_ROUTING_KEY,
      afterHoursRoutingKey: process.env.PAGERDUTY_AFTER_HOURS_ROUTING_KEY,
      businessHoursStart: process.env.PAGERDUTY_BUSINESS_HOURS_START,
      businessHoursEnd: process.env.PAGERDUTY_BUSINESS_HOURS_END,
    },
  });

export const config = {
  ...coreConfig,
  ...platformExtras,
};

export type Config = typeof config;
