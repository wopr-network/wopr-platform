import type { ProfileRepository } from "../../domain/repositories/profile-repository.js";
import type { BotProfile } from "../../fleet/types.js";

export class DrizzleProfileRepository implements ProfileRepository {
  constructor(private readonly dataDir: string) {}

  async save(profile: BotProfile): Promise<void> {
    const { ProfileStore } = await import("../../fleet/profile-store.js");
    const store = new ProfileStore(this.dataDir);
    await store.init();
    await store.save(profile);
  }

  async get(id: string): Promise<BotProfile | null> {
    const { ProfileStore } = await import("../../fleet/profile-store.js");
    const store = new ProfileStore(this.dataDir);
    return store.get(id);
  }

  async list(): Promise<BotProfile[]> {
    const { ProfileStore } = await import("../../fleet/profile-store.js");
    const store = new ProfileStore(this.dataDir);
    return store.list();
  }

  async delete(id: string): Promise<boolean> {
    const { ProfileStore } = await import("../../fleet/profile-store.js");
    const store = new ProfileStore(this.dataDir);
    return store.delete(id);
  }
}
