/**
 * Repository Interface: ProfileRepository (ASYNC)
 *
 * Manages bot profile templates persisted as YAML files.
 */
import type { BotProfile } from "../../fleet/types.js";

export interface ProfileRepository {
  /**
   * Save a profile to storage.
   */
  save(profile: BotProfile): Promise<void>;

  /**
   * Get a profile by ID. Returns null if not found.
   */
  get(id: string): Promise<BotProfile | null>;

  /**
   * List all profiles.
   */
  list(): Promise<BotProfile[]>;

  /**
   * Delete a profile by ID. Returns true if deleted, false if not found.
   */
  delete(id: string): Promise<boolean>;
}
