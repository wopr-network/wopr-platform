/**
 * Auth user repository — read/write the better-auth SQLite user and account tables.
 *
 * Uses raw better-sqlite3 queries because better-auth manages its own schema
 * independently of Drizzle. The auth DB is a separate file from the platform DB.
 */

import { hashPassword, verifyPassword } from "better-auth/crypto";
// biome-ignore lint/style/useImportType: Database namespace needed for Database.Database type reference
import Database from "better-sqlite3";

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  image: string | null;
}

export interface IAuthUserRepository {
  getUser(userId: string): AuthUser | null;
  updateUser(userId: string, data: { name?: string; image?: string | null }): AuthUser;
  changePassword(userId: string, currentPassword: string, newPassword: string): Promise<boolean>;
}

export class BetterAuthUserRepository implements IAuthUserRepository {
  constructor(private readonly db: Database.Database) {}

  getUser(userId: string): AuthUser | null {
    return (
      (this.db.prepare("SELECT id, name, email, image FROM user WHERE id = ?").get(userId) as AuthUser | undefined) ??
      null
    );
  }

  updateUser(userId: string, data: { name?: string; image?: string | null }): AuthUser {
    const fields: string[] = [];
    const values: unknown[] = [];
    if (data.name !== undefined) {
      fields.push("name = ?");
      values.push(data.name);
    }
    if (data.image !== undefined) {
      fields.push("image = ?");
      values.push(data.image);
    }
    if (fields.length > 0) {
      values.push(userId);
      this.db.prepare(`UPDATE user SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    }
    return this.db.prepare("SELECT id, name, email, image FROM user WHERE id = ?").get(userId) as AuthUser;
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string): Promise<boolean> {
    const row = this.db
      .prepare("SELECT password FROM account WHERE user_id = ? AND provider_id = 'credential'")
      .get(userId) as { password: string } | undefined;
    if (!row?.password) return false;
    const valid = await verifyPassword({ hash: row.password, password: currentPassword });
    if (!valid) return false;
    const newHash = await hashPassword(newPassword);
    this.db
      .prepare("UPDATE account SET password = ? WHERE user_id = ? AND provider_id = 'credential'")
      .run(newHash, userId);
    return true;
  }
}
