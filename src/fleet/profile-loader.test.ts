import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadProfileTemplates, parseProfileTemplate } from "./profile-loader.js";

describe("parseProfileTemplate", () => {
  it("parses valid YAML into a ProfileTemplate", () => {
    const yaml = `
name: test-bot
description: A test bot
channel:
  plugin: test-channel
  config:
    TOKEN: abc
provider:
  plugin: test-provider
  config:
    KEY: xyz
release: canary
image: "ghcr.io/wopr-network/test:canary"
`;
    const result = parseProfileTemplate(yaml, "test.yaml");
    expect(result.name).toBe("test-bot");
    expect(result.release).toBe("canary");
    expect(result.channel.plugin).toBe("test-channel");
    expect(result.provider.config.KEY).toBe("xyz");
  });

  it("throws on invalid YAML content", () => {
    const yaml = `
name: test-bot
release: invalid-channel
`;
    expect(() => parseProfileTemplate(yaml, "bad.yaml")).toThrow('Invalid profile template "bad.yaml"');
  });
});

describe("loadProfileTemplates", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wopr-templates-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const validYaml = `
name: test-bot
description: A test bot
channel:
  plugin: test-channel
provider:
  plugin: test-provider
release: stable
image: "ghcr.io/wopr-network/test:stable"
`;

  it("loads all .yaml files from directory", () => {
    fs.writeFileSync(path.join(tmpDir, "bot1.yaml"), validYaml);
    fs.writeFileSync(path.join(tmpDir, "bot2.yml"), validYaml.replace("test-bot", "bot-two"));

    const templates = loadProfileTemplates(tmpDir);
    expect(templates).toHaveLength(2);
  });

  it("ignores non-YAML files", () => {
    fs.writeFileSync(path.join(tmpDir, "bot.yaml"), validYaml);
    fs.writeFileSync(path.join(tmpDir, "readme.txt"), "not yaml");

    const templates = loadProfileTemplates(tmpDir);
    expect(templates).toHaveLength(1);
  });

  it("returns empty array for non-existent directory", () => {
    const templates = loadProfileTemplates("/tmp/does-not-exist-wopr-test");
    expect(templates).toEqual([]);
  });

  it("returns empty array for empty directory", () => {
    const templates = loadProfileTemplates(tmpDir);
    expect(templates).toEqual([]);
  });

  it("throws on invalid template file", () => {
    fs.writeFileSync(path.join(tmpDir, "bad.yaml"), "name: x\nrelease: nope\n");

    expect(() => loadProfileTemplates(tmpDir)).toThrow("Invalid profile template");
  });
});

import { defaultTemplatesDir } from "./profile-loader.js";

describe("defaultTemplatesDir", () => {
  it("returns FLEET_TEMPLATES_DIR env var when set", () => {
    const orig = process.env.FLEET_TEMPLATES_DIR;
    try {
      process.env.FLEET_TEMPLATES_DIR = "/custom/templates";
      const dir = defaultTemplatesDir();
      expect(dir).toBe("/custom/templates");
    } finally {
      if (orig === undefined) {
        delete process.env.FLEET_TEMPLATES_DIR;
      } else {
        process.env.FLEET_TEMPLATES_DIR = orig;
      }
    }
  });

  it("returns a path containing 'templates' when env var is not set", () => {
    const orig = process.env.FLEET_TEMPLATES_DIR;
    try {
      delete process.env.FLEET_TEMPLATES_DIR;
      const dir = defaultTemplatesDir();
      expect(dir).toContain("templates");
    } finally {
      if (orig !== undefined) process.env.FLEET_TEMPLATES_DIR = orig;
    }
  });
});
