import crypto from "node:crypto";
import type { IExportRepository } from "./export-repository.js";
import type { ExportRequest } from "./export-repository-types.js";

export type { ExportRequest } from "./export-repository-types.js";

export interface IAccountExportStore {
  create(tenantId: string, requestedBy: string, format?: string): Promise<ExportRequest>;
  getById(id: string): Promise<ExportRequest | null>;
  list(filters: {
    status?: string;
    limit: number;
    offset: number;
  }): Promise<{ requests: ExportRequest[]; total: number }>;
  updateStatus(id: string, status: string, downloadUrl?: string): Promise<void>;
}

export class AccountExportStore implements IAccountExportStore {
  constructor(private readonly repo: IExportRepository) {}

  async create(tenantId: string, requestedBy: string, format?: string): Promise<ExportRequest> {
    const id = crypto.randomUUID();
    await this.repo.insert({ id, tenantId, requestedBy, format });
    const created = await this.repo.getById(id);
    if (!created) throw new Error(`Failed to retrieve newly created export request: ${id}`);
    return created;
  }

  async getById(id: string): Promise<ExportRequest | null> {
    return this.repo.getById(id);
  }

  async list(filters: {
    status?: string;
    limit: number;
    offset: number;
  }): Promise<{ requests: ExportRequest[]; total: number }> {
    const result = await this.repo.list(filters);
    return { requests: result.rows, total: result.total };
  }

  async updateStatus(id: string, status: string, downloadUrl?: string): Promise<void> {
    return this.repo.updateStatus(id, status, downloadUrl);
  }
}
