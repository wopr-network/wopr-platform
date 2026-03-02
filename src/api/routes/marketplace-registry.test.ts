// Tests for the marketplace plugin seed data integrity.
// The seed data lives in scripts/seed-marketplace-plugins.ts and is the
// single source of truth for first-party plugin manifests.
import { describe, expect, it } from "vitest";
import { FIRST_PARTY_PLUGINS } from "../../marketplace/first-party-plugins.js";
import type { PluginCategory, PluginManifest } from "./marketplace-registry.js";

const VALID_CATEGORIES: PluginCategory[] = [
  "channel",
  "provider",
  "voice",
  "memory",
  "context",
  "webhook",
  "integration",
  "ui",
  "moderation",
  "analytics",
];

const VALID_FIELD_TYPES = ["string", "number", "boolean", "select"] as const;

// Re-export seed data as pluginRegistry for test compatibility
const pluginRegistry: PluginManifest[] = FIRST_PARTY_PLUGINS;

describe("marketplace plugin seed data integrity", () => {
  it("seed data is a non-empty array", () => {
    expect(Array.isArray(pluginRegistry)).toBe(true);
    expect(pluginRegistry.length).toBeGreaterThan(0);
  });

  it("every plugin has a unique id", () => {
    const ids = pluginRegistry.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every plugin has required string fields", () => {
    for (const p of pluginRegistry) {
      expect(p.id).toBeTruthy();
      expect(typeof p.id).toBe("string");
      expect(p.name).toBeTruthy();
      expect(typeof p.name).toBe("string");
      expect(p.description).toBeTruthy();
      expect(typeof p.description).toBe("string");
      expect(p.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(p.author).toBeTruthy();
      expect(p.icon).toBeTruthy();
      expect(p.color).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });

  it("every plugin has a valid category", () => {
    for (const p of pluginRegistry) {
      expect(VALID_CATEGORIES).toContain(p.category);
    }
  });

  it("tags, capabilities, requires, install are arrays", () => {
    for (const p of pluginRegistry) {
      expect(Array.isArray(p.tags)).toBe(true);
      expect(Array.isArray(p.capabilities)).toBe(true);
      expect(Array.isArray(p.requires)).toBe(true);
      expect(Array.isArray(p.install)).toBe(true);
    }
  });

  it("installCount is a non-negative number", () => {
    for (const p of pluginRegistry) {
      expect(typeof p.installCount).toBe("number");
      expect(p.installCount).toBeGreaterThanOrEqual(0);
    }
  });

  it("changelog entries have valid structure", () => {
    for (const p of pluginRegistry) {
      expect(Array.isArray(p.changelog)).toBe(true);
      for (const entry of p.changelog) {
        expect(entry.version).toMatch(/^\d+\.\d+\.\d+$/);
        expect(entry.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(entry.notes).toBeTruthy();
      }
    }
  });

  it("configSchema fields have valid types", () => {
    for (const p of pluginRegistry) {
      for (const field of p.configSchema) {
        expect(field.key).toBeTruthy();
        expect(field.label).toBeTruthy();
        expect(VALID_FIELD_TYPES as readonly string[]).toContain(field.type);
        expect(typeof field.required).toBe("boolean");
      }
    }
  });

  it("select-type configSchema fields have options", () => {
    for (const p of pluginRegistry) {
      for (const field of p.configSchema) {
        if (field.type === "select") {
          expect(Array.isArray(field.options)).toBe(true);
          expect(field.options?.length).toBeGreaterThan(0);
          for (const opt of field.options ?? []) {
            expect(opt.label).toBeTruthy();
            expect(opt.value).toBeTruthy();
          }
        }
      }
    }
  });

  it("setup steps have valid structure", () => {
    for (const p of pluginRegistry) {
      expect(Array.isArray(p.setup)).toBe(true);
      for (const step of p.setup) {
        expect(step.id).toBeTruthy();
        expect(step.title).toBeTruthy();
        expect(step.description).toBeTruthy();
        expect(Array.isArray(step.fields)).toBe(true);
      }
    }
  });

  it("requires references exist in the registry", () => {
    const allIds = new Set(pluginRegistry.map((p) => p.id));
    for (const p of pluginRegistry) {
      for (const req of p.requires) {
        expect(allIds.has(req.id)).toBe(true);
      }
    }
  });

  it("validation patterns are valid regexes", () => {
    for (const p of pluginRegistry) {
      for (const field of p.configSchema) {
        if (field.validation) {
          expect(() => new RegExp(field.validation?.pattern ?? "")).not.toThrow();
          expect(field.validation.message).toBeTruthy();
        }
      }
    }
  });

  it("contains expected well-known plugins", () => {
    const ids = new Set(pluginRegistry.map((p) => p.id));
    expect(ids.has("discord-channel")).toBe(true);
    expect(ids.has("slack-channel")).toBe(true);
    expect(ids.has("semantic-memory")).toBe(true);
    expect(ids.has("elevenlabs-tts")).toBe(true);
  });

  it("discord-channel has correct shape", () => {
    const discord = pluginRegistry.find((p) => p.id === "discord-channel");
    expect(discord).not.toBeUndefined();
    if (!discord) return;
    expect(discord.category).toBe("channel");
    expect(discord.configSchema.length).toBeGreaterThan(0);
    expect(discord.configSchema.some((f) => f.key === "botToken")).toBe(true);
    expect(discord.setup.length).toBeGreaterThan(0);
  });

  it("meeting-transcriber requires discord-channel", () => {
    const mt = pluginRegistry.find((p) => p.id === "meeting-transcriber");
    expect(mt).not.toBeUndefined();
    if (!mt) return;
    const reqIds = mt.requires.map((r) => r.id);
    expect(reqIds).toContain("discord-channel");
  });
});
