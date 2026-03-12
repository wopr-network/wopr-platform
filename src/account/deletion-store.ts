import crypto from "node:crypto";
import type { IDeletionRepository } from "@wopr-network/platform-core/account/deletion-repository";
import type { DeletionRequestRow } from "@wopr-network/platform-core/account/repository-types";

export type { DeletionRequestRow } from "@wopr-network/platform-core/account/repository-types";

export const DELETION_GRACE_DAYS = 30;

export interface IAccountDeletionStore {
  create(tenantId: string, requestedBy: string, reason?: string | null): Promise<DeletionRequestRow>;
  getById(id: string): Promise<DeletionRequestRow | null>;
  getPendingForTenant(tenantId: string): Promise<DeletionRequestRow | null>;
  cancel(id: string, reason: string): Promise<void>;
  markCompleted(id: string, summary: Record<string, number>): Promise<void>;
  findExpired(): Promise<DeletionRequestRow[]>;
  list(opts: {
    status?: string;
    limit: number;
    offset: number;
  }): Promise<{ requests: DeletionRequestRow[]; total: number }>;
}

export class AccountDeletionStore implements IAccountDeletionStore {
  constructor(private readonly repo: IDeletionRepository) {}

  /** Create a new deletion request with a 30-day grace period. Returns the created request. */
  async create(tenantId: string, requestedBy: string, reason?: string | null): Promise<DeletionRequestRow> {
    const id = crypto.randomUUID();
    await this.repo.insert({ id, tenantId, requestedBy, graceDays: DELETION_GRACE_DAYS, reason });
    const created = await this.repo.getById(id);
    if (!created) throw new Error(`Failed to retrieve newly created deletion request: ${id}`);
    return created;
  }

  /** Get a deletion request by ID. */
  async getById(id: string): Promise<DeletionRequestRow | null> {
    return this.repo.getById(id);
  }

  /** Get the active (pending) deletion request for a tenant. */
  async getPendingForTenant(tenantId: string): Promise<DeletionRequestRow | null> {
    return this.repo.getPendingForTenant(tenantId);
  }

  /** Cancel a pending deletion request. */
  async cancel(id: string, reason: string): Promise<void> {
    await this.repo.cancel(id, reason);
  }

  /** Mark a deletion request as completed with a summary. */
  async markCompleted(id: string, summary: Record<string, number>): Promise<void> {
    return this.repo.markCompleted(id, JSON.stringify(summary));
  }

  /** Find all pending requests whose grace period has expired. */
  async findExpired(): Promise<DeletionRequestRow[]> {
    return this.repo.findExpired();
  }

  /** List deletion requests with optional status filter and pagination. */
  async list(opts: {
    status?: string;
    limit: number;
    offset: number;
  }): Promise<{ requests: DeletionRequestRow[]; total: number }> {
    return this.repo.list(opts);
  }
}
