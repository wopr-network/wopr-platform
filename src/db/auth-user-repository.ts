/**
 * Auth user repository — read/write the better-auth PostgreSQL user and account tables.
 *
 * Uses raw pg queries because better-auth manages its own schema
 * independently of Drizzle.
 */

import { hashPassword, verifyPassword } from "better-auth/crypto";
import type { Pool } from "pg";

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  image: string | null;
}

export interface IAuthUserRepository {
  getUser(userId: string): Promise<AuthUser | null>;
  updateUser(userId: string, data: { name?: string; image?: string | null }): Promise<AuthUser>;
  changePassword(userId: string, currentPassword: string, newPassword: string): Promise<boolean>;
}

export class BetterAuthUserRepository implements IAuthUserRepository {
  constructor(private readonly pool: Pool) {}

  async getUser(userId: string): Promise<AuthUser | null> {
    const { rows } = await this.pool.query(`SELECT id, name, email, image FROM "user" WHERE id = $1`, [userId]);
    return (rows[0] as AuthUser | undefined) ?? null;
  }

  async updateUser(userId: string, data: { name?: string; image?: string | null }): Promise<AuthUser> {
    const fields: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (data.name !== undefined) {
      fields.push(`name = $${paramIndex++}`);
      values.push(data.name);
    }
    if (data.image !== undefined) {
      fields.push(`image = $${paramIndex++}`);
      values.push(data.image);
    }
    if (fields.length > 0) {
      values.push(userId);
      await this.pool.query(`UPDATE "user" SET ${fields.join(", ")} WHERE id = $${paramIndex}`, values);
    }
    const { rows } = await this.pool.query(`SELECT id, name, email, image FROM "user" WHERE id = $1`, [userId]);
    return rows[0] as AuthUser;
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string): Promise<boolean> {
    const { rows } = await this.pool.query(
      `SELECT password FROM account WHERE user_id = $1 AND provider_id = 'credential'`,
      [userId],
    );
    const row = rows[0] as { password: string } | undefined;
    if (!row?.password) return false;
    const valid = await verifyPassword({ hash: row.password, password: currentPassword });
    if (!valid) return false;
    const newHash = await hashPassword(newPassword);
    await this.pool.query(`UPDATE account SET password = $1 WHERE user_id = $2 AND provider_id = 'credential'`, [
      newHash,
      userId,
    ]);
    return true;
  }
}
