import { and, desc, eq, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "../db/schema/index.js";
import { nodes } from "../db/schema/index.js";

export interface PlacementResult {
  nodeId: string;
  host: string;
  availableMb: number;
}

/**
 * Bin-packing placement: find the active node with the MOST free capacity
 * that can fit the requested memory. This is a "first-fit decreasing"
 * approach — simple, effective, avoids overloading small nodes.
 *
 * @param db - Drizzle database instance
 * @param requiredMb - Memory the new bot needs (default: 100 MB)
 * @returns The best node, or null if no node has capacity
 */
export function findPlacement(db: BetterSQLite3Database<typeof schema>, requiredMb = 100): PlacementResult | null {
  const result = db
    .select({
      nodeId: nodes.id,
      host: nodes.host,
      availableMb: sql<number>`(${nodes.capacityMb} - ${nodes.usedMb})`,
    })
    .from(nodes)
    .where(and(eq(nodes.status, "active"), sql`(${nodes.capacityMb} - ${nodes.usedMb}) >= ${requiredMb}`))
    .orderBy(desc(sql`${nodes.capacityMb} - ${nodes.usedMb}`))
    .limit(1)
    .get();

  return result ?? null;
}

/**
 * Variant: find placement excluding specific node(s).
 * Used during migration to avoid placing back on source node.
 */
export function findPlacementExcluding(
  db: BetterSQLite3Database<typeof schema>,
  excludeNodeIds: string[],
  requiredMb = 100,
): PlacementResult | null {
  if (excludeNodeIds.length === 0) return findPlacement(db, requiredMb);

  const result = db
    .select({
      nodeId: nodes.id,
      host: nodes.host,
      availableMb: sql<number>`(${nodes.capacityMb} - ${nodes.usedMb})`,
    })
    .from(nodes)
    .where(
      and(
        eq(nodes.status, "active"),
        sql`(${nodes.capacityMb} - ${nodes.usedMb}) >= ${requiredMb}`,
        sql`${nodes.id} NOT IN (${sql.join(
          excludeNodeIds.map((id) => sql`${id}`),
          sql`, `,
        )})`,
      ),
    )
    .orderBy(desc(sql`${nodes.capacityMb} - ${nodes.usedMb}`))
    .limit(1)
    .get();

  return result ?? null;
}
