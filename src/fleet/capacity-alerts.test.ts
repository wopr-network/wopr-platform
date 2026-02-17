import { describe, expect, it } from "vitest";
import { checkCapacityAlerts } from "./capacity-alerts.js";
import type { NodeInfo } from "./node-connection-manager.js";

function makeNode(overrides: Partial<NodeInfo>): NodeInfo {
  return {
    id: "node-1",
    host: "1.2.3.4",
    status: "active",
    capacityMb: 8192,
    usedMb: 0,
    agentVersion: null,
    lastHeartbeatAt: null,
    registeredAt: 0,
    ...overrides,
  };
}

describe("checkCapacityAlerts", () => {
  it("returns empty array for healthy cluster", () => {
    const nodes = [
      makeNode({ id: "node-1", usedMb: 1000, capacityMb: 8192 }), // ~12%
      makeNode({ id: "node-2", usedMb: 2000, capacityMb: 8192 }), // ~24%
    ];
    expect(checkCapacityAlerts(nodes)).toEqual([]);
  });

  it("returns warning at 80% threshold", () => {
    const nodes = [makeNode({ id: "node-1", usedMb: 6600, capacityMb: 8192 })]; // ~80.6%
    const alerts = checkCapacityAlerts(nodes);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].level).toBe("warning");
    expect(alerts[0].nodeId).toBe("node-1");
    expect(alerts[0].message).toContain("consider adding a node");
  });

  it("returns critical at 95% threshold", () => {
    const nodes = [makeNode({ id: "node-1", usedMb: 7800, capacityMb: 8192 })]; // ~95.2%
    const alerts = checkCapacityAlerts(nodes);
    const nodeAlert = alerts.find((a) => a.nodeId === "node-1");
    expect(nodeAlert).toBeDefined();
    expect(nodeAlert?.level).toBe("critical");
    expect(nodeAlert?.message).toContain("new tenants routed elsewhere");
  });

  it("returns fleet-level critical when all active nodes above 90%", () => {
    const nodes = [
      makeNode({ id: "node-1", usedMb: 7500, capacityMb: 8192, status: "active" }), // ~91.5%
      makeNode({ id: "node-2", usedMb: 7600, capacityMb: 8192, status: "active" }), // ~92.8%
    ];
    const alerts = checkCapacityAlerts(nodes);
    const fleetAlert = alerts.find((a) => a.nodeId === "fleet");
    expect(fleetAlert).toBeDefined();
    expect(fleetAlert?.level).toBe("critical");
    expect(fleetAlert?.message).toContain("add a node NOW");
  });

  it("does not include draining nodes in fleet-level check", () => {
    const nodes = [
      makeNode({ id: "node-1", usedMb: 7500, capacityMb: 8192, status: "active" }), // ~91.5%
      makeNode({ id: "node-2", usedMb: 7600, capacityMb: 8192, status: "draining" }), // excluded
    ];
    const alerts = checkCapacityAlerts(nodes);
    // Only 1 active node above 90% — no fleet alert (needs all active > 90%)
    const fleetAlert = alerts.find((a) => a.nodeId === "fleet");
    expect(fleetAlert).toBeDefined(); // 1 active node, all of them above 90%
    expect(fleetAlert?.message).toContain("1 nodes above 90%");
  });

  it("skips nodes with zero capacity", () => {
    const nodes = [makeNode({ id: "node-1", usedMb: 0, capacityMb: 0 })];
    expect(checkCapacityAlerts(nodes)).toEqual([]);
  });

  it("returns empty array for empty node list", () => {
    expect(checkCapacityAlerts([])).toEqual([]);
  });
});
