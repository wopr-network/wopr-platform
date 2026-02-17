import type { NodeInfo } from "./node-connection-manager.js";

export interface CapacityAlert {
  nodeId: string;
  level: "warning" | "critical";
  usedPercent: number;
  message: string;
}

/**
 * Check all nodes for capacity alerts.
 * - 80% = warning ("Consider adding a node")
 * - 95% = critical ("New tenants routed elsewhere")
 * - All active nodes above 90% = fleet-level critical
 */
export function checkCapacityAlerts(nodes: NodeInfo[]): CapacityAlert[] {
  const alerts: CapacityAlert[] = [];

  for (const node of nodes) {
    if (node.capacityMb === 0) continue;
    const usedPercent = (node.usedMb / node.capacityMb) * 100;

    if (usedPercent >= 95) {
      alerts.push({
        nodeId: node.id,
        level: "critical",
        usedPercent: Math.round(usedPercent),
        message: `Node ${node.id} at ${Math.round(usedPercent)}% capacity — new tenants routed elsewhere`,
      });
    } else if (usedPercent >= 80) {
      alerts.push({
        nodeId: node.id,
        level: "warning",
        usedPercent: Math.round(usedPercent),
        message: `Node ${node.id} at ${Math.round(usedPercent)}% capacity — consider adding a node`,
      });
    }
  }

  // Check if ALL active nodes are above 90%
  const activeNodes = nodes.filter((n) => n.status === "active");
  const allAbove90 =
    activeNodes.length > 0 && activeNodes.every((n) => n.capacityMb > 0 && (n.usedMb / n.capacityMb) * 100 >= 90);
  if (allAbove90) {
    alerts.push({
      nodeId: "fleet",
      level: "critical",
      usedPercent: 0,
      message: `All ${activeNodes.length} nodes above 90% capacity — add a node NOW`,
    });
  }

  return alerts;
}
