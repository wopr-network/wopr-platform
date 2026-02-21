export interface NodeInput {
  id: string;
  host: string;
  status: string;
  capacityMb: number;
  usedMb: number;
}

export interface PlacementResult {
  nodeId: string;
  host: string;
  availableMb: number;
}

/**
 * Pure bin-packing placement: find the active node with the MOST free capacity.
 * Operates on an in-memory node list — no DB access.
 *
 * @param nodes - In-memory list of nodes to search
 * @param requiredMb - Memory the new bot needs (default: 100 MB)
 * @returns The best node, or null if no node has capacity
 */
export function findPlacement(nodes: NodeInput[], requiredMb = 100): PlacementResult | null {
  const best = nodes
    .filter((n) => n.status === "active" && n.capacityMb - n.usedMb >= requiredMb)
    .sort((a, b) => b.capacityMb - b.usedMb - (a.capacityMb - a.usedMb))[0];

  if (!best) return null;

  return {
    nodeId: best.id,
    host: best.host,
    availableMb: best.capacityMb - best.usedMb,
  };
}

/**
 * Pure variant: find placement excluding specific node(s).
 * Used during migration to avoid placing back on source node.
 */
export function findPlacementExcluding(
  nodes: NodeInput[],
  excludeNodeIds: string[],
  requiredMb = 100,
): PlacementResult | null {
  if (excludeNodeIds.length === 0) return findPlacement(nodes, requiredMb);

  const excludeSet = new Set(excludeNodeIds);
  return findPlacement(
    nodes.filter((n) => !excludeSet.has(n.id)),
    requiredMb,
  );
}
