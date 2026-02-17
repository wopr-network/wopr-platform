import { describe, expect, it } from "vitest";
import { generateCloudInit } from "./cloud-init.js";

describe("generateCloudInit", () => {
  it("starts with cloud-config directive", () => {
    const result = generateCloudInit("ghcr.io/wopr-network/wopr:latest");
    expect(result.startsWith("#cloud-config\n")).toBe(true);
  });

  it("includes docker.io package", () => {
    const result = generateCloudInit("ghcr.io/wopr-network/wopr:latest");
    expect(result).toContain("- docker.io");
  });

  it("interpolates the bot image correctly", () => {
    const image = "ghcr.io/wopr-network/wopr:v1.2.3";
    const result = generateCloudInit(image);
    expect(result).toContain(`docker pull ${image}`);
  });

  it("includes WOPR_NODE_READY marker", () => {
    const result = generateCloudInit("ghcr.io/wopr-network/wopr:latest");
    expect(result).toContain("WOPR_NODE_READY");
  });

  it("includes systemctl enable docker", () => {
    const result = generateCloudInit("ghcr.io/wopr-network/wopr:latest");
    expect(result).toContain("systemctl enable docker");
    expect(result).toContain("systemctl start docker");
  });
});
