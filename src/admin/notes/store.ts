import crypto from "node:crypto";
import { count, desc, eq } from "drizzle-orm";
import type { DrizzleDb } from "../../db/index.js";
import { adminNotes } from "../../db/schema/index.js";

export interface AdminNote {
  id: string;
  tenantId: string;
  authorId: string;
  content: string;
  isPinned: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface AdminNoteInput {
  tenantId: string;
  authorId: string;
  content: string;
  isPinned?: boolean;
}

export interface AdminNoteFilters {
  tenantId: string;
  limit?: number;
  offset?: number;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 250;

export class AdminNotesStore {
  constructor(private readonly db: DrizzleDb) {}

  /** Add a new note. */
  create(input: AdminNoteInput): AdminNote {
    const id = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);

    this.db
      .insert(adminNotes)
      .values({
        id,
        tenantId: input.tenantId,
        authorId: input.authorId,
        content: input.content,
        isPinned: input.isPinned ? 1 : 0,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    return {
      id,
      tenantId: input.tenantId,
      authorId: input.authorId,
      content: input.content,
      isPinned: input.isPinned ?? false,
      createdAt: now,
      updatedAt: now,
    };
  }

  /** List notes for a tenant, pinned first, then by recency. */
  list(filters: AdminNoteFilters): { entries: AdminNote[]; total: number } {
    const where = eq(adminNotes.tenantId, filters.tenantId);

    const countResult = this.db.select({ count: count() }).from(adminNotes).where(where).get();
    const total = countResult?.count ?? 0;

    const limit = Math.min(Math.max(1, filters.limit ?? DEFAULT_LIMIT), MAX_LIMIT);
    const offset = Math.max(0, filters.offset ?? 0);

    const rows = this.db
      .select()
      .from(adminNotes)
      .where(where)
      .orderBy(desc(adminNotes.isPinned), desc(adminNotes.createdAt))
      .limit(limit)
      .offset(offset)
      .all();

    return {
      entries: rows.map((r) => ({
        id: r.id,
        tenantId: r.tenantId,
        authorId: r.authorId,
        content: r.content,
        isPinned: r.isPinned === 1,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      })),
      total,
    };
  }

  /** Update a note's content or pinned status. Returns null if not found or tenantId mismatch. */
  update(noteId: string, tenantId: string, updates: { content?: string; isPinned?: boolean }): AdminNote | null {
    const existing = this.db.select().from(adminNotes).where(eq(adminNotes.id, noteId)).get();

    if (!existing) return null;
    if (existing.tenantId !== tenantId) return null;

    const now = Math.floor(Date.now() / 1000);
    const setValues: Record<string, unknown> = { updatedAt: now };

    if (updates.content !== undefined) setValues.content = updates.content;
    if (updates.isPinned !== undefined) setValues.isPinned = updates.isPinned ? 1 : 0;

    this.db.update(adminNotes).set(setValues).where(eq(adminNotes.id, noteId)).run();

    const updated = this.db.select().from(adminNotes).where(eq(adminNotes.id, noteId)).get();

    if (!updated) return null;

    return {
      id: updated.id,
      tenantId: updated.tenantId,
      authorId: updated.authorId,
      content: updated.content,
      isPinned: updated.isPinned === 1,
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt,
    };
  }

  /** Delete a note by ID. Returns false if not found or tenantId mismatch. */
  delete(noteId: string, tenantId: string): boolean {
    const existing = this.db.select().from(adminNotes).where(eq(adminNotes.id, noteId)).get();

    if (!existing) return false;
    if (existing.tenantId !== tenantId) return false;

    const result = this.db.delete(adminNotes).where(eq(adminNotes.id, noteId)).run();
    return result.changes > 0;
  }
}
