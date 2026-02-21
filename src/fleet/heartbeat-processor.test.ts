import { describe, expect, it, vi } from "vitest";
import type { HeartbeatMessage } from "../node-agent/types.js";
import { HeartbeatProcessor } from "./heartbeat-processor.js";

function makeNodeRepo() {
  return {
    updateHeartbeat: vi.fn(),
  };
}

describe("HeartbeatProcessor", () => {
  it("calls updateHeartbeat with sum of container memory_mb values", () => {
    const nodeRepo = makeNodeRepo();
    const processor = new HeartbeatProcessor(nodeRepo);

    const msg: HeartbeatMessage = {
      type: "heartbeat",
      node_id: "node-1",
      uptime_s: 3600,
      memory_total_mb: 8192,
      memory_used_mb: 4096,
      disk_total_gb: 100,
      disk_used_gb: 50,
      containers: [
        { name: "tenant_abc", status: "running", memory_mb: 256, uptime_s: 100 },
        { name: "tenant_def", status: "running", memory_mb: 512, uptime_s: 200 },
      ],
    };

    processor.process("node-1", msg);

    expect(nodeRepo.updateHeartbeat).toHaveBeenCalledOnce();
    expect(nodeRepo.updateHeartbeat).toHaveBeenCalledWith("node-1", 768);
  });

  it("uses 0 usedMb when containers array is absent", () => {
    const nodeRepo = makeNodeRepo();
    const processor = new HeartbeatProcessor(nodeRepo);

    const msg: HeartbeatMessage = {
      type: "heartbeat",
      node_id: "node-1",
      uptime_s: 3600,
      memory_total_mb: 8192,
      memory_used_mb: 4096,
      disk_total_gb: 100,
      disk_used_gb: 50,
    };

    processor.process("node-1", msg);

    expect(nodeRepo.updateHeartbeat).toHaveBeenCalledOnce();
    expect(nodeRepo.updateHeartbeat).toHaveBeenCalledWith("node-1", 0);
  });
});
