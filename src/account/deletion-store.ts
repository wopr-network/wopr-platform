import crypto from "node:crypto";
import type { IDeletionRepository } from "./deletion-repository.js";
import type { DeletionRequest } from "./repository-types.js";

export type { DeletionRequest } from "./repository-types.js";

export const DELETION_GRACE_DAYS = 30;

export class AccountDeletionStore {
  constructor(private readonly repo: IDeletionRepository) {}

  /** Create a new deletion request with a 30-day grace period. Returns the created request. */
  create(tenantId: string, requestedBy: string): DeletionRequest {
    const id = crypto.randomUUID();
    this.repo.insert({ id, tenantId, requestedBy, graceDays: DELETION_GRACE_DAYS });
    const created = this.repo.getById(id);
    if (!created) throw new Error(`Failed to retrieve newly created deletion request: ${id}`);
    return created;
  }

  /** Get a deletion request by ID. */
  getById(id: string): DeletionRequest | null {
    return this.repo.getById(id);
  }

  /** Get the active (pending) deletion request for a tenant. */
  getPendingForTenant(tenantId: string): DeletionRequest | null {
    return this.repo.getPendingForTenant(tenantId);
  }

  /** Cancel a pending deletion request. */
  cancel(id: string, reason: string): void {
    this.repo.cancel(id, reason);
  }

  /** Mark a deletion request as completed with a summary. */
  markCompleted(id: string, summary: Record<string, number>): void {
    this.repo.markCompleted(id, JSON.stringify(summary));
  }

  /** Find all pending requests whose grace period has expired. */
  findExpired(): DeletionRequest[] {
    return this.repo.findExpired();
  }
}
