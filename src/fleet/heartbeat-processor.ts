import type { HeartbeatMessage } from "../node-agent/types.js";

/** Minimal subset of INodeRepository needed by HeartbeatProcessor. */
export interface INodeRepository {
  updateHeartbeat(id: string, usedMb: number): void;
}

/**
 * Processes a single heartbeat message from a node agent.
 *
 * Computes usedMb by summing container memory_mb values,
 * then delegates persistence to nodeRepo.updateHeartbeat().
 */
export class HeartbeatProcessor {
  private readonly nodeRepo: INodeRepository;

  constructor(nodeRepo: INodeRepository) {
    this.nodeRepo = nodeRepo;
  }

  process(nodeId: string, msg: HeartbeatMessage): void {
    const usedMb = msg.containers?.reduce((sum, c) => sum + (c.memory_mb ?? 0), 0) ?? 0;
    this.nodeRepo.updateHeartbeat(nodeId, usedMb);
  }
}
