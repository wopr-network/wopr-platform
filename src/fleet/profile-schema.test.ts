import { describe, expect, it } from "vitest";
import { profileTemplateSchema } from "./profile-schema.js";

describe("profileTemplateSchema", () => {
  const validTemplate = {
    name: "stable-discord",
    description: "Primary user-facing Discord bot",
    channel: {
      plugin: "@wopr-network/wopr-plugin-channel-discord",
      config: { DISCORD_TOKEN: "test-discord-token" },
    },
    provider: {
      plugin: "@wopr-network/wopr-plugin-provider-anthropic",
      config: { ANTHROPIC_API_KEY: "test-anthropic-key" },
    },
    release: "stable",
    image: "ghcr.io/wopr-network/wopr:stable",
  };

  it("accepts a valid template with all required fields", () => {
    const result = profileTemplateSchema.safeParse(validTemplate);
    expect(result.success).toBe(true);
  });

  it("applies defaults for optional fields", () => {
    const result = profileTemplateSchema.parse(validTemplate);
    expect(result.restartPolicy).toBe("unless-stopped");
    expect(result.healthCheck).toEqual({
      endpoint: "/health",
      intervalSeconds: 30,
      timeoutSeconds: 5,
      retries: 3,
    });
    expect(result.volumes).toEqual([]);
    expect(result.env).toEqual({});
  });

  it("accepts all release channel values", () => {
    for (const release of ["stable", "canary", "staging"]) {
      const result = profileTemplateSchema.safeParse({ ...validTemplate, release });
      expect(result.success).toBe(true);
    }
  });

  it("rejects an invalid release channel", () => {
    const result = profileTemplateSchema.safeParse({ ...validTemplate, release: "nightly" });
    expect(result.success).toBe(false);
  });

  it("rejects missing name", () => {
    const { name: _, ...noName } = validTemplate;
    const result = profileTemplateSchema.safeParse(noName);
    expect(result.success).toBe(false);
  });

  it("rejects empty name", () => {
    const result = profileTemplateSchema.safeParse({ ...validTemplate, name: "" });
    expect(result.success).toBe(false);
  });

  it("rejects missing channel", () => {
    const { channel: _, ...noChannel } = validTemplate;
    const result = profileTemplateSchema.safeParse(noChannel);
    expect(result.success).toBe(false);
  });

  it("rejects missing provider", () => {
    const { provider: _, ...noProvider } = validTemplate;
    const result = profileTemplateSchema.safeParse(noProvider);
    expect(result.success).toBe(false);
  });

  it("rejects missing image", () => {
    const { image: _, ...noImage } = validTemplate;
    const result = profileTemplateSchema.safeParse(noImage);
    expect(result.success).toBe(false);
  });

  it("accepts valid restart policies", () => {
    for (const restartPolicy of ["no", "always", "on-failure", "unless-stopped"]) {
      const result = profileTemplateSchema.safeParse({ ...validTemplate, restartPolicy });
      expect(result.success).toBe(true);
    }
  });

  it("accepts volume mounts", () => {
    const result = profileTemplateSchema.parse({
      ...validTemplate,
      volumes: [{ host: "/data/bot", container: "/app/data", readonly: true }],
    });
    expect(result.volumes).toHaveLength(1);
    expect(result.volumes[0].readonly).toBe(true);
  });

  it("defaults volume readonly to false", () => {
    const result = profileTemplateSchema.parse({
      ...validTemplate,
      volumes: [{ host: "/data/bot", container: "/app/data" }],
    });
    expect(result.volumes[0].readonly).toBe(false);
  });

  it("accepts custom health check", () => {
    const result = profileTemplateSchema.parse({
      ...validTemplate,
      healthCheck: { endpoint: "/ready", intervalSeconds: 10, timeoutSeconds: 2, retries: 5 },
    });
    expect(result.healthCheck.endpoint).toBe("/ready");
    expect(result.healthCheck.intervalSeconds).toBe(10);
  });

  it("accepts channel config with empty config", () => {
    const result = profileTemplateSchema.parse({
      ...validTemplate,
      channel: { plugin: "some-plugin" },
    });
    expect(result.channel.config).toEqual({});
  });
});
