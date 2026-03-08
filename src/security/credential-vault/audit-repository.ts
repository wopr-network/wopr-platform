import { count, desc, eq } from "drizzle-orm";
import type { DrizzleDb } from "../../db/index.js";
import { secretAuditLog } from "../../db/schema/index.js";

export interface SecretAuditEvent {
  id: string;
  credentialId: string;
  accessedAt: number;
  accessedBy: string;
  action: "read" | "write" | "delete";
  ip: string | null;
}

export interface ISecretAuditRepository {
  insert(event: SecretAuditEvent): Promise<void>;
  listByCredentialId(credentialId: string, opts: { limit: number; offset: number }): Promise<SecretAuditEvent[]>;
  countByCredentialId(credentialId: string): Promise<number>;
}

const MAX_LIMIT = 250;

export class DrizzleSecretAuditRepository implements ISecretAuditRepository {
  constructor(private readonly db: DrizzleDb) {}

  async insert(event: SecretAuditEvent): Promise<void> {
    await this.db.insert(secretAuditLog).values({
      id: event.id,
      credentialId: event.credentialId,
      accessedAt: event.accessedAt,
      accessedBy: event.accessedBy,
      action: event.action,
      ip: event.ip,
    });
  }

  async listByCredentialId(credentialId: string, opts: { limit: number; offset: number }): Promise<SecretAuditEvent[]> {
    const limit = Math.min(Math.max(1, opts.limit), MAX_LIMIT);
    const offset = Math.max(0, opts.offset);

    const rows = await this.db
      .select()
      .from(secretAuditLog)
      .where(eq(secretAuditLog.credentialId, credentialId))
      .orderBy(desc(secretAuditLog.accessedAt))
      .limit(limit)
      .offset(offset);

    return rows.map((r) => ({
      id: r.id,
      credentialId: r.credentialId,
      accessedAt: r.accessedAt,
      accessedBy: r.accessedBy,
      action: r.action as "read" | "write" | "delete",
      ip: r.ip,
    }));
  }

  async countByCredentialId(credentialId: string): Promise<number> {
    const result = (
      await this.db.select({ count: count() }).from(secretAuditLog).where(eq(secretAuditLog.credentialId, credentialId))
    )[0];
    return result?.count ?? 0;
  }
}
