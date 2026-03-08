/** Plain domain object for an export request — mirrors `account_export_requests` table. */
export interface ExportRequest {
  id: string;
  tenantId: string;
  requestedBy: string;
  status: string;
  format: string;
  downloadUrl: string | null;
  createdAt: string;
  updatedAt: string;
}
