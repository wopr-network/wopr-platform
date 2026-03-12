import { describe, expect, it } from "vitest";
import { generateGpuCloudInit } from "@wopr-network/platform-core/fleet/gpu-cloud-init";

describe("generateGpuCloudInit", () => {
  it("should return valid cloud-config with NVIDIA setup", () => {
    const result = generateGpuCloudInit({
      nodeId: "gpu-abc12345",
      platformUrl: "https://api.wopr.bot",
      gpuNodeSecret: "test-secret",
    });
    expect(result).toContain("#cloud-config");
    expect(result).toContain("nvidia");
    expect(result).toContain("docker");
  });
});
