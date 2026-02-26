import type { AdminNote, AdminNoteFilters, AdminNoteInput } from "../admin-repository-types.js";

// Re-export for convenience
export type { AdminNote, AdminNoteFilters, AdminNoteInput };

export interface IAdminNotesRepository {
  create(input: AdminNoteInput): Promise<AdminNote>;
  list(filters: AdminNoteFilters): Promise<{ entries: AdminNote[]; total: number }>;
  update(
    noteId: string,
    tenantId: string,
    updates: { content?: string; isPinned?: boolean },
  ): Promise<AdminNote | null>;
  delete(noteId: string, tenantId: string): Promise<boolean>;
}
