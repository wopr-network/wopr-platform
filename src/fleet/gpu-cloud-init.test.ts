import { describe, expect, it } from "vitest";
import { generateGpuCloudInit } from "./gpu-cloud-init.js";

const validParams = {
  nodeId: "gpu-node-abc123",
  platformUrl: "https://api.wopr.network",
  gpuNodeSecret: "secret-token-xyz",
};

describe("generateGpuCloudInit", () => {
  it("starts with cloud-config directive", () => {
    const result = generateGpuCloudInit(validParams);
    expect(result.startsWith("#cloud-config\n")).toBe(true);
  });

  it("rejects nodeId with shell metacharacters", () => {
    expect(() => generateGpuCloudInit({ ...validParams, nodeId: "node; rm -rf /" })).toThrow("Invalid nodeId");
  });

  it("rejects nodeId with backticks", () => {
    expect(() => generateGpuCloudInit({ ...validParams, nodeId: "`whoami`" })).toThrow("Invalid nodeId");
  });

  it("rejects platformUrl with spaces", () => {
    expect(() => generateGpuCloudInit({ ...validParams, platformUrl: "http://evil .com" })).toThrow(
      "Invalid platformUrl",
    );
  });

  it("rejects gpuNodeSecret with shell metacharacters", () => {
    expect(() => generateGpuCloudInit({ ...validParams, gpuNodeSecret: "secret;echo pwned" })).toThrow(
      "Invalid gpuNodeSecret",
    );
  });

  it("strips trailing slash from platformUrl", () => {
    const result = generateGpuCloudInit({
      ...validParams,
      platformUrl: "https://api.wopr.network/",
    });
    expect(result).not.toContain("//internal/gpu/register");
    expect(result).toContain("https://api.wopr.network/internal/gpu/register");
  });

  it("installs NVIDIA drivers and container toolkit", () => {
    const result = generateGpuCloudInit(validParams);
    expect(result).toContain("nvidia-driver-535");
    expect(result).toContain("nvidia-container-toolkit");
  });

  it("installs Docker and configures NVIDIA runtime as default", () => {
    const result = generateGpuCloudInit(validParams);
    expect(result).toContain("docker.io");
    expect(result).toContain("nvidia-ctk runtime configure --runtime=docker --set-as-default");
  });

  it("downloads model weights to /opt/models/", () => {
    const result = generateGpuCloudInit(validParams);
    expect(result).toContain("mkdir -p /opt/models");
    expect(result).toContain("--local-dir /opt/models/llama");
    expect(result).toContain("--local-dir /opt/models/qwen");
    expect(result).toContain("--local-dir /opt/models/whisper");
  });

  it("uses default model names when modelConfig is omitted", () => {
    const result = generateGpuCloudInit(validParams);
    expect(result).toContain("TheBloke/Llama-2-7B-Chat-GGUF");
    expect(result).toContain("Qwen/Qwen2.5-7B-Instruct-GGUF");
    expect(result).toContain("Systran/faster-whisper-base.en");
  });

  it("uses custom model names from modelConfig", () => {
    const result = generateGpuCloudInit({
      ...validParams,
      modelConfig: {
        llamaModel: "meta-llama/Meta-Llama-3-8B-GGUF",
        qwenModel: "Qwen/Qwen2-7B-GGUF",
        whisperModel: "Systran/faster-whisper-large-v3",
      },
    });
    expect(result).toContain("meta-llama/Meta-Llama-3-8B-GGUF");
    expect(result).toContain("Qwen/Qwen2-7B-GGUF");
    expect(result).toContain("Systran/faster-whisper-large-v3");
    expect(result).not.toContain("TheBloke/Llama-2-7B-Chat-GGUF");
  });

  it("writes docker-compose.gpu.yml to /opt/wopr-gpu/", () => {
    const result = generateGpuCloudInit(validParams);
    expect(result).toContain("/opt/wopr-gpu/docker-compose.gpu.yml");
    expect(result).toContain("docker compose -f docker-compose.gpu.yml up -d");
  });

  it("writes .env with nodeId, platformUrl, gpuNodeSecret", () => {
    const result = generateGpuCloudInit(validParams);
    expect(result).toContain(`NODE_ID=${validParams.nodeId}`);
    expect(result).toContain(`PLATFORM_URL=${validParams.platformUrl}`);
    expect(result).toContain(`GPU_NODE_SECRET=${validParams.gpuNodeSecret}`);
  });

  it("pings stage at each step in correct order", () => {
    const result = generateGpuCloudInit(validParams);
    const stages = ["installing_drivers", "installing_docker", "downloading_models", "starting_services", "done"];
    for (const stage of stages) {
      expect(result).toContain(`/internal/gpu/register?stage=${stage}`);
    }
    const positions = stages.map((s) => result.indexOf(`stage=${s}`));
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i]).toBeGreaterThan(positions[i - 1]);
    }
  });

  it("pings include Authorization header with gpuNodeSecret", () => {
    const result = generateGpuCloudInit(validParams);
    expect(result).toContain(`Authorization: Bearer ${validParams.gpuNodeSecret}`);
  });

  it("pings include nodeId in JSON body", () => {
    const result = generateGpuCloudInit(validParams);
    expect(result).toContain(`"nodeId":"${validParams.nodeId}"`);
  });

  it("rejects model names with shell metacharacters", () => {
    expect(() =>
      generateGpuCloudInit({
        ...validParams,
        modelConfig: { llamaModel: "model;echo pwned" },
      }),
    ).toThrow("Invalid model name");
  });
});
