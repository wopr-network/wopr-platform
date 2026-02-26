import type { BotProfile } from "./types.js";

/**
 * Repository interface for bot profiles.
 * Replaces the YAML-based ProfileStore.
 */
export interface IBotProfileRepository {
  get(id: string): Promise<BotProfile | null>;
  save(profile: BotProfile): Promise<BotProfile>; // upsert
  delete(id: string): Promise<boolean>;
  list(): Promise<BotProfile[]>;
}
