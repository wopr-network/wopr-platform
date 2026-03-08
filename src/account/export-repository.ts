import { count, desc, eq, sql } from "drizzle-orm";
import type { DrizzleDb } from "../db/index.js";
import { accountExportRequests } from "../db/schema/account-export-requests.js";
import type { ExportRequest, ExportStatus, InsertExportRequest } from "./export-repository-types.js";

export interface IExportRepository {
  insert(data: InsertExportRequest): Promise<void>;
  getById(id: string): Promise<ExportRequest | null>;
  list(filters: {
    status?: ExportStatus;
    limit: number;
    offset: number;
  }): Promise<{ rows: ExportRequest[]; total: number }>;
  updateStatus(id: string, status: ExportStatus, downloadUrl?: string): Promise<void>;
}

export class DrizzleExportRepository implements IExportRepository {
  constructor(private readonly db: DrizzleDb) {}

  async insert(data: InsertExportRequest): Promise<void> {
    await this.db.insert(accountExportRequests).values({
      id: data.id,
      tenantId: data.tenantId,
      requestedBy: data.requestedBy,
      format: data.format ?? "json",
    });
  }

  async getById(id: string): Promise<ExportRequest | null> {
    const rows = await this.db.select().from(accountExportRequests).where(eq(accountExportRequests.id, id));
    return rows[0] ? toExportRequest(rows[0]) : null;
  }

  async list(filters: {
    status?: ExportStatus;
    limit: number;
    offset: number;
  }): Promise<{ rows: ExportRequest[]; total: number }> {
    const conditions = filters.status ? eq(accountExportRequests.status, filters.status) : undefined;

    const [rows, countResult] = await Promise.all([
      this.db
        .select()
        .from(accountExportRequests)
        .where(conditions)
        .orderBy(desc(accountExportRequests.createdAt))
        .limit(filters.limit)
        .offset(filters.offset),
      this.db.select({ count: count() }).from(accountExportRequests).where(conditions),
    ]);

    return {
      rows: rows.map(toExportRequest),
      total: Number(countResult[0]?.count ?? 0),
    };
  }

  async updateStatus(id: string, status: ExportStatus, downloadUrl?: string): Promise<void> {
    await this.db
      .update(accountExportRequests)
      .set({
        status,
        ...(downloadUrl !== undefined ? { downloadUrl } : {}),
        updatedAt: sql`now()::text`,
      })
      .where(eq(accountExportRequests.id, id));
  }
}

function toExportRequest(row: typeof accountExportRequests.$inferSelect): ExportRequest {
  return {
    id: row.id,
    tenantId: row.tenantId,
    requestedBy: row.requestedBy,
    status: row.status as ExportStatus,
    format: row.format,
    downloadUrl: row.downloadUrl,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
