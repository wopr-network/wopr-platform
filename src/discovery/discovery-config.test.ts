import { describe, expect, it } from "vitest";
import { buildDiscoveryEnv } from "./discovery-config.js";
import {
  DEFAULT_DISCOVERY_TOPIC,
  DISCOVERY_TOPICS_ENV,
  discoveryConfigSchema,
  platformDiscoveryConfigSchema,
} from "./types.js";

describe("buildDiscoveryEnv", () => {
  it("returns default topic when no config provided", () => {
    const env = buildDiscoveryEnv();
    expect(env).toEqual({ [DISCOVERY_TOPICS_ENV]: DEFAULT_DISCOVERY_TOPIC });
  });

  it("returns default topic when discovery is enabled with no extra topics", () => {
    const env = buildDiscoveryEnv({ enabled: true, topics: [] });
    expect(env).toEqual({ [DISCOVERY_TOPICS_ENV]: "wopr-service" });
  });

  it("returns empty-string env var when discovery is disabled (overrides pre-existing)", () => {
    const env = buildDiscoveryEnv({ enabled: false, topics: [] });
    expect(env).toEqual({ [DISCOVERY_TOPICS_ENV]: "" });
  });

  it("returns empty-string env var when disabled even with extra topics", () => {
    const env = buildDiscoveryEnv({ enabled: false, topics: ["wopr-org-acme"] });
    expect(env).toEqual({ [DISCOVERY_TOPICS_ENV]: "" });
  });

  it("includes extra topics alongside default topic", () => {
    const env = buildDiscoveryEnv({ enabled: true, topics: ["wopr-org-acme", "wopr-team-red"] });
    expect(env[DISCOVERY_TOPICS_ENV]).toBeDefined();

    const topics = env[DISCOVERY_TOPICS_ENV].split(",");
    expect(topics).toContain("wopr-service");
    expect(topics).toContain("wopr-org-acme");
    expect(topics).toContain("wopr-team-red");
    expect(topics).toHaveLength(3);
  });

  it("deduplicates when extra topic matches default", () => {
    const env = buildDiscoveryEnv({ enabled: true, topics: ["wopr-service"] });
    const topics = env[DISCOVERY_TOPICS_ENV].split(",");
    expect(topics).toEqual(["wopr-service"]);
  });

  it("uses custom platform default topic", () => {
    const env = buildDiscoveryEnv({ enabled: true, topics: [] }, { defaultTopic: "my-custom-network" });
    expect(env).toEqual({ [DISCOVERY_TOPICS_ENV]: "my-custom-network" });
  });

  it("combines custom platform topic with instance topics", () => {
    const env = buildDiscoveryEnv({ enabled: true, topics: ["wopr-org-acme"] }, { defaultTopic: "my-network" });
    const topics = env[DISCOVERY_TOPICS_ENV].split(",");
    expect(topics).toContain("my-network");
    expect(topics).toContain("wopr-org-acme");
  });
});

describe("discoveryConfigSchema", () => {
  it("applies defaults", () => {
    const result = discoveryConfigSchema.parse({});
    expect(result.enabled).toBe(true);
    expect(result.topics).toEqual([]);
  });

  it("accepts explicit values", () => {
    const result = discoveryConfigSchema.parse({
      enabled: false,
      topics: ["wopr-org-acme"],
    });
    expect(result.enabled).toBe(false);
    expect(result.topics).toEqual(["wopr-org-acme"]);
  });

  it("rejects empty topic strings", () => {
    const result = discoveryConfigSchema.safeParse({ topics: [""] });
    expect(result.success).toBe(false);
  });

  it("rejects topics exceeding max length", () => {
    const result = discoveryConfigSchema.safeParse({ topics: ["x".repeat(129)] });
    expect(result.success).toBe(false);
  });

  it("accepts topics at max length", () => {
    const result = discoveryConfigSchema.safeParse({ topics: ["x".repeat(128)] });
    expect(result.success).toBe(true);
  });

  it("rejects topics containing commas", () => {
    const result = discoveryConfigSchema.safeParse({ topics: ["wopr-org,acme"] });
    expect(result.success).toBe(false);
  });

  it("accepts topics without commas", () => {
    const result = discoveryConfigSchema.safeParse({ topics: ["wopr-org-acme"] });
    expect(result.success).toBe(true);
  });
});

describe("platformDiscoveryConfigSchema", () => {
  it("applies default topic", () => {
    const result = platformDiscoveryConfigSchema.parse({});
    expect(result.defaultTopic).toBe(DEFAULT_DISCOVERY_TOPIC);
  });

  it("rejects defaultTopic exceeding max length", () => {
    const result = platformDiscoveryConfigSchema.safeParse({ defaultTopic: "x".repeat(129) });
    expect(result.success).toBe(false);
  });

  it("accepts defaultTopic at max length", () => {
    const result = platformDiscoveryConfigSchema.safeParse({ defaultTopic: "x".repeat(128) });
    expect(result.success).toBe(true);
  });
});
