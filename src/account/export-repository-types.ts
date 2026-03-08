export type ExportStatus = "pending" | "processing" | "completed" | "failed";

export interface InsertExportRequest {
  id: string;
  tenantId: string;
  requestedBy: string;
  format?: string;
}

/** Plain domain object for an export request — mirrors `account_export_requests` table. */
export interface ExportRequest {
  id: string;
  tenantId: string;
  requestedBy: string;
  status: ExportStatus;
  format: string;
  downloadUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
}
