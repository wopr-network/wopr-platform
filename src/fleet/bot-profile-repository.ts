import type { BotProfile } from "./types.js";

/**
 * Repository interface for bot profiles.
 * Replaces the YAML-based ProfileStore.
 */
export interface IBotProfileRepository {
  get(id: string): BotProfile | null;
  save(profile: BotProfile): BotProfile; // upsert
  delete(id: string): boolean;
  list(): BotProfile[];
}
