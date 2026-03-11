import type { RoleStore } from "@wopr-network/platform-core/admin";
import { logger } from "../config/logger.js";

export interface IUserCreator {
  createUser(userId: string): Promise<void>;
}

class UserCreator implements IUserCreator {
  async createUser(_userId: string): Promise<void> {
    // No-op for normal signups
  }
}

class AdminUserCreator implements IUserCreator {
  constructor(
    private readonly roleStore: RoleStore,
    private readonly holder: UserCreatorHolder,
  ) {}

  async createUser(userId: string): Promise<void> {
    // Swap to no-op BEFORE await to prevent concurrent double-promoting.
    // Save the current creator so we can restore it on failure.
    const previous = this.holder.creator;
    this.holder.creator = new UserCreator();
    try {
      await this.roleStore.setRole(userId, "*", "platform_admin", "bootstrap");
      logger.info(`Bootstrap: first user ${userId} auto-promoted to platform_admin`);
    } catch (err) {
      // Restore holder so the next signup can retry bootstrap
      this.holder.creator = previous;
      throw err;
    }
  }
}

class UserCreatorHolder {
  creator: IUserCreator;
  constructor(creator: IUserCreator) {
    this.creator = creator;
  }
}

/**
 * Create a user creator that auto-promotes the first signup to platform_admin
 * when no admins exist. After promotion, all subsequent signups are no-ops.
 */
export async function createUserCreator(roleStore: RoleStore): Promise<IUserCreator> {
  const holder = new UserCreatorHolder(new UserCreator());
  const count = await roleStore.countPlatformAdmins();
  if (count === 0) {
    holder.creator = new AdminUserCreator(roleStore, holder);
  }
  return { createUser: (id) => holder.creator.createUser(id) };
}
