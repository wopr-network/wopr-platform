import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getSharedVolumeConfig } from "./shared-volume-config.js";

describe("getSharedVolumeConfig", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns defaults when no env vars set", () => {
    delete process.env.SHARED_NODE_MODULES_VOLUME;
    delete process.env.SHARED_NODE_MODULES_MOUNT;
    delete process.env.SHARED_NODE_MODULES_ENABLED;

    const config = getSharedVolumeConfig();
    expect(config).toEqual({
      enabled: true,
      volumeName: "wopr-shared-node-modules",
      mountPath: "/shared/node_modules",
    });
  });

  it("respects custom volume name from env", () => {
    process.env.SHARED_NODE_MODULES_VOLUME = "custom-vol";
    const config = getSharedVolumeConfig();
    expect(config.volumeName).toBe("custom-vol");
  });

  it("respects custom mount path from env", () => {
    process.env.SHARED_NODE_MODULES_MOUNT = "/opt/shared/nm";
    const config = getSharedVolumeConfig();
    expect(config.mountPath).toBe("/opt/shared/nm");
  });

  it("can be disabled via env", () => {
    process.env.SHARED_NODE_MODULES_ENABLED = "false";
    const config = getSharedVolumeConfig();
    expect(config.enabled).toBe(false);
  });
});
