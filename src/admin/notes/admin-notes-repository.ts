import type { AdminNote, AdminNoteFilters, AdminNoteInput } from "../admin-repository-types.js";

// Re-export for convenience
export type { AdminNote, AdminNoteFilters, AdminNoteInput };

export interface IAdminNotesRepository {
  create(input: AdminNoteInput): AdminNote;
  list(filters: AdminNoteFilters): { entries: AdminNote[]; total: number };
  update(noteId: string, tenantId: string, updates: { content?: string; isPinned?: boolean }): AdminNote | null;
  delete(noteId: string, tenantId: string): boolean;
}
