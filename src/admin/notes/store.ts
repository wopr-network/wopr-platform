import crypto from "node:crypto";
import { count, desc, eq } from "drizzle-orm";
import type { DrizzleDb } from "../../db/index.js";
import { adminNotes } from "../../db/schema/index.js";
import type { AdminNote, AdminNoteFilters, AdminNoteInput } from "../admin-repository-types.js";
import type { IAdminNotesRepository } from "./admin-notes-repository.js";

export type { AdminNote, AdminNoteFilters, AdminNoteInput };

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 250;

export class AdminNotesStore implements IAdminNotesRepository {
  constructor(private readonly db: DrizzleDb) {}

  /** Add a new note. */
  async create(input: AdminNoteInput): Promise<AdminNote> {
    const id = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);

    await this.db.insert(adminNotes).values({
      id,
      tenantId: input.tenantId,
      authorId: input.authorId,
      content: input.content,
      isPinned: input.isPinned ?? false,
      createdAt: now,
      updatedAt: now,
    });

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
  async list(filters: AdminNoteFilters): Promise<{ entries: AdminNote[]; total: number }> {
    const where = eq(adminNotes.tenantId, filters.tenantId);

    const countResult = await this.db.select({ count: count() }).from(adminNotes).where(where);
    const total = countResult[0]?.count ?? 0;

    const limit = Math.min(Math.max(1, filters.limit ?? DEFAULT_LIMIT), MAX_LIMIT);
    const offset = Math.max(0, filters.offset ?? 0);

    const rows = await this.db
      .select()
      .from(adminNotes)
      .where(where)
      .orderBy(desc(adminNotes.isPinned), desc(adminNotes.createdAt))
      .limit(limit)
      .offset(offset);

    return {
      entries: rows.map((r) => ({
        id: r.id,
        tenantId: r.tenantId,
        authorId: r.authorId,
        content: r.content,
        isPinned: r.isPinned,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      })),
      total,
    };
  }

  /** Update a note's content or pinned status. Returns null if not found or tenantId mismatch. */
  async update(
    noteId: string,
    tenantId: string,
    updates: { content?: string; isPinned?: boolean },
  ): Promise<AdminNote | null> {
    const existingRows = await this.db.select().from(adminNotes).where(eq(adminNotes.id, noteId));
    const existing = existingRows[0];

    if (!existing) return null;
    if (existing.tenantId !== tenantId) return null;

    const now = Math.floor(Date.now() / 1000);
    const setValues: Record<string, unknown> = { updatedAt: now };

    if (updates.content !== undefined) setValues.content = updates.content;
    if (updates.isPinned !== undefined) setValues.isPinned = updates.isPinned;

    await this.db.update(adminNotes).set(setValues).where(eq(adminNotes.id, noteId));

    const updatedRows = await this.db.select().from(adminNotes).where(eq(adminNotes.id, noteId));
    const updated = updatedRows[0];

    if (!updated) return null;

    return {
      id: updated.id,
      tenantId: updated.tenantId,
      authorId: updated.authorId,
      content: updated.content,
      isPinned: updated.isPinned,
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt,
    };
  }

  /** Delete a note by ID. Returns false if not found or tenantId mismatch. */
  async delete(noteId: string, tenantId: string): Promise<boolean> {
    const existingRows = await this.db.select().from(adminNotes).where(eq(adminNotes.id, noteId));
    const existing = existingRows[0];

    if (!existing) return false;
    if (existing.tenantId !== tenantId) return false;

    const result = await this.db.delete(adminNotes).where(eq(adminNotes.id, noteId)).returning({ id: adminNotes.id });
    return result.length > 0;
  }
}
