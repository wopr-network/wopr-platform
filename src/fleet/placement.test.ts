import { describe, expect, it } from "vitest";
import { findPlacement, findPlacementExcluding, type NodeInput } from "./placement.js";

function node(overrides: Partial<NodeInput> & { id: string }): NodeInput {
  return {
    host: "10.0.0.1",
    status: "active",
    capacityMb: 1000,
    usedMb: 0,
    ...overrides,
  };
}

describe("findPlacement", () => {
  it("returns the node with most free capacity", () => {
    const nodes: NodeInput[] = [
      node({ id: "node-1", capacityMb: 1000, usedMb: 800 }), // 200 free
      node({ id: "node-2", host: "10.0.0.2", capacityMb: 2000, usedMb: 500 }), // 1500 free (winner)
      node({ id: "node-3", host: "10.0.0.3", capacityMb: 1000, usedMb: 950 }), // 50 free (not enough)
    ];

    const result = findPlacement(nodes, 100);
    expect(result).not.toBeNull();
    expect(result?.nodeId).toBe("node-2");
    expect(result?.availableMb).toBe(1500);
  });

  it("returns the host for the winning node", () => {
    const nodes = [node({ id: "node-1", host: "10.0.0.1", capacityMb: 1000, usedMb: 0 })];

    const result = findPlacement(nodes, 100);
    expect(result).not.toBeNull();
    expect(result?.host).toBe("10.0.0.1");
  });

  it("returns null when no node has capacity", () => {
    const nodes = [node({ id: "node-1", capacityMb: 1000, usedMb: 950 })];

    const result = findPlacement(nodes, 100);
    expect(result).toBeNull();
  });

  it("returns null when nodes array is empty", () => {
    const result = findPlacement([], 100);
    expect(result).toBeNull();
  });

  it("skips non-active draining nodes", () => {
    const nodes = [
      node({ id: "node-1", capacityMb: 2000, usedMb: 0, status: "draining" }),
      node({ id: "node-2", host: "10.0.0.2", capacityMb: 1000, usedMb: 0 }),
    ];

    const result = findPlacement(nodes, 100);
    expect(result).not.toBeNull();
    expect(result?.nodeId).toBe("node-2");
  });

  it("skips offline and unhealthy and recovering nodes", () => {
    const nodes = [
      node({ id: "node-1", capacityMb: 2000, usedMb: 0, status: "offline" }),
      node({ id: "node-2", host: "10.0.0.2", capacityMb: 2000, usedMb: 0, status: "unhealthy" }),
      node({ id: "node-3", host: "10.0.0.3", capacityMb: 2000, usedMb: 0, status: "recovering" }),
    ];

    const result = findPlacement(nodes, 100);
    expect(result).toBeNull();
  });

  it("skips returning nodes", () => {
    const nodeList: NodeInput[] = [
      node({ id: "node-1", capacityMb: 2000, usedMb: 0, status: "returning" }),
      node({ id: "node-2", host: "10.0.0.2", capacityMb: 1000, usedMb: 0, status: "active" }),
    ];

    const result = findPlacement(nodeList, 100);
    expect(result).not.toBeNull();
    expect(result?.nodeId).toBe("node-2");
  });

  it("uses 100 MB as default requiredMb", () => {
    const nodes = [node({ id: "node-1", capacityMb: 1000, usedMb: 900 })];

    const result = findPlacement(nodes);
    expect(result).not.toBeNull();
    expect(result?.nodeId).toBe("node-1");
    expect(result?.availableMb).toBe(100);
  });

  it("returns null when free capacity is exactly below required", () => {
    const nodes = [node({ id: "node-1", capacityMb: 1000, usedMb: 901 })];

    const result = findPlacement(nodes);
    expect(result).toBeNull();
  });
});

describe("findPlacementExcluding", () => {
  it("excludes specified node IDs", () => {
    const nodes = [
      node({ id: "node-1", capacityMb: 2000, usedMb: 0 }),
      node({ id: "node-2", host: "10.0.0.2", capacityMb: 1000, usedMb: 0 }),
    ];

    const result = findPlacementExcluding(nodes, ["node-1"], 100);
    expect(result).not.toBeNull();
    expect(result?.nodeId).toBe("node-2");
  });

  it("returns null when all nodes excluded", () => {
    const nodes = [node({ id: "node-1", capacityMb: 2000, usedMb: 0 })];

    const result = findPlacementExcluding(nodes, ["node-1"], 100);
    expect(result).toBeNull();
  });

  it("excludes multiple node IDs", () => {
    const nodes = [
      node({ id: "node-1", capacityMb: 2000, usedMb: 0 }),
      node({ id: "node-2", host: "10.0.0.2", capacityMb: 1500, usedMb: 0 }),
      node({ id: "node-3", host: "10.0.0.3", capacityMb: 1000, usedMb: 0 }),
    ];

    const result = findPlacementExcluding(nodes, ["node-1", "node-2"], 100);
    expect(result).not.toBeNull();
    expect(result?.nodeId).toBe("node-3");
  });

  it("delegates to findPlacement when excludeNodeIds is empty", () => {
    const nodes = [node({ id: "node-1", capacityMb: 2000, usedMb: 0 })];

    const result = findPlacementExcluding(nodes, [], 100);
    expect(result).not.toBeNull();
    expect(result?.nodeId).toBe("node-1");
  });

  it("skips returning nodes", () => {
    const nodeList: NodeInput[] = [
      node({ id: "node-1", capacityMb: 2000, usedMb: 0, status: "returning" }),
      node({ id: "node-2", host: "10.0.0.2", capacityMb: 1000, usedMb: 0, status: "active" }),
    ];

    const result = findPlacementExcluding(nodeList, ["node-3"], 100);
    expect(result).not.toBeNull();
    expect(result?.nodeId).toBe("node-2");
  });

  it("still picks most free capacity among non-excluded nodes", () => {
    const nodes = [
      node({ id: "node-1", capacityMb: 2000, usedMb: 0 }),
      node({ id: "node-2", host: "10.0.0.2", capacityMb: 1500, usedMb: 0 }),
      node({ id: "node-3", host: "10.0.0.3", capacityMb: 800, usedMb: 0 }),
    ];

    const result = findPlacementExcluding(nodes, ["node-1"], 100);
    expect(result).not.toBeNull();
    expect(result?.nodeId).toBe("node-2");
  });
});
