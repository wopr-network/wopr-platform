import { randomUUID } from "node:crypto";
import type { IRestoreLogRepository, RestoreLogEntry } from "./repository-types.js";

export type { RestoreLogEntry };

export class RestoreLogStore {
  private readonly repo: IRestoreLogRepository;

  constructor(repo: IRestoreLogRepository) {
    this.repo = repo;
  }

  /** Record a restore event. Returns the created entry. */
  async record(params: {
    tenant: string;
    snapshotKey: string;
    preRestoreKey: string | null;
    restoredBy: string;
    reason?: string;
  }): Promise<RestoreLogEntry> {
    const entry: RestoreLogEntry = {
      id: randomUUID(),
      tenant: params.tenant,
      snapshotKey: params.snapshotKey,
      preRestoreKey: params.preRestoreKey,
      restoredAt: Math.floor(Date.now() / 1000),
      restoredBy: params.restoredBy,
      reason: params.reason ?? null,
    };

    await this.repo.insert(entry);
    return entry;
  }

  /** List restore events for a tenant, newest first. */
  async listForTenant(tenant: string, limit = 50): Promise<RestoreLogEntry[]> {
    return this.repo.listByTenant(tenant, limit);
  }

  /** Get a single restore event by ID. */
  async get(id: string): Promise<RestoreLogEntry | null> {
    return this.repo.getById(id);
  }
}
