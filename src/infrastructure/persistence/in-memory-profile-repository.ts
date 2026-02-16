import type { ProfileRepository } from "../../domain/repositories/profile-repository.js";
import type { BotProfile } from "../../fleet/types.js";

export class InMemoryProfileRepository implements ProfileRepository {
  private profiles = new Map<string, BotProfile>();

  async save(profile: BotProfile): Promise<void> {
    this.profiles.set(profile.id, profile);
  }

  async get(id: string): Promise<BotProfile | null> {
    return this.profiles.get(id) ?? null;
  }

  async list(): Promise<BotProfile[]> {
    return Array.from(this.profiles.values());
  }

  async delete(id: string): Promise<boolean> {
    return this.profiles.delete(id);
  }

  /**
   * Reset the in-memory store (for testing).
   */
  reset(): void {
    this.profiles.clear();
  }
}
