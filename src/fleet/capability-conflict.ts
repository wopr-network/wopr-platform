import type { PluginManifest } from "../api/routes/marketplace-registry.js";

export interface CapabilityConflict {
  /** The conflicting capability name (e.g., "tts") */
  capability: string;
  /** The plugin ID that already provides this capability */
  existingPluginId: string;
  /** The plugin ID being installed that also provides it */
  newPluginId: string;
}

/**
 * Detect capability conflicts between a new plugin and already-installed plugins.
 * Returns one conflict entry per overlapping capability (first existing provider wins).
 */
export function detectCapabilityConflicts(
  newPluginId: string,
  installedPluginIds: string[],
  registry: Pick<PluginManifest, "id" | "capabilities">[],
): CapabilityConflict[] {
  const newEntry = registry.find((p) => p.id === newPluginId);
  if (!newEntry || newEntry.capabilities.length === 0) return [];

  // Build map: capability -> first installed pluginId that provides it
  const installedSet = new Set(installedPluginIds);
  const capToPlugin = new Map<string, string>();
  for (const entry of registry) {
    if (!installedSet.has(entry.id)) continue;
    for (const cap of entry.capabilities) {
      if (!capToPlugin.has(cap)) {
        capToPlugin.set(cap, entry.id);
      }
    }
  }

  const conflicts: CapabilityConflict[] = [];
  for (const cap of newEntry.capabilities) {
    const existing = capToPlugin.get(cap);
    if (existing) {
      conflicts.push({ capability: cap, existingPluginId: existing, newPluginId });
    }
  }

  return conflicts;
}
