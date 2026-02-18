import type BetterSqlite3 from "better-sqlite3";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAdminNotesApiRoutes } from "../../api/routes/admin-notes.js";
import type { DrizzleDb } from "../../db/index.js";
import { createTestDb } from "../../test/db.js";
import { AdminNotesStore } from "./store.js";

describe("AdminNotesStore.create", () => {
  let db: DrizzleDb;
  let sqlite: BetterSqlite3.Database;
  let store: AdminNotesStore;

  beforeEach(() => {
    const t = createTestDb();
    db = t.db;
    sqlite = t.sqlite;
    store = new AdminNotesStore(db);
  });

  afterEach(() => {
    sqlite.close();
  });

  it("creates a note and returns all fields populated", () => {
    const note = store.create({
      tenantId: "tenant-1",
      authorId: "admin-1",
      content: "Test note content",
    });

    expect(note.id).toBeTruthy();
    expect(note.tenantId).toBe("tenant-1");
    expect(note.authorId).toBe("admin-1");
    expect(note.content).toBe("Test note content");
    expect(note.isPinned).toBe(false);
    expect(note.createdAt).toBeGreaterThan(0);
    expect(note.updatedAt).toBeGreaterThan(0);
  });

  it("creates a note with isPinned: true", () => {
    const note = store.create({
      tenantId: "tenant-1",
      authorId: "admin-1",
      content: "Pinned note",
      isPinned: true,
    });

    expect(note.isPinned).toBe(true);
  });

  it("generates unique IDs", () => {
    const n1 = store.create({ tenantId: "tenant-1", authorId: "admin-1", content: "Note 1" });
    const n2 = store.create({ tenantId: "tenant-1", authorId: "admin-1", content: "Note 2" });
    expect(n1.id).not.toBe(n2.id);
  });
});

describe("AdminNotesStore.list", () => {
  let db: DrizzleDb;
  let sqlite: BetterSqlite3.Database;
  let store: AdminNotesStore;

  beforeEach(() => {
    const t = createTestDb();
    db = t.db;
    sqlite = t.sqlite;
    store = new AdminNotesStore(db);
  });

  afterEach(() => {
    sqlite.close();
  });

  it("returns notes for the correct tenant only", () => {
    store.create({ tenantId: "tenant-1", authorId: "admin-1", content: "Note A" });
    store.create({ tenantId: "tenant-2", authorId: "admin-1", content: "Note B" });

    const result = store.list({ tenantId: "tenant-1" });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].tenantId).toBe("tenant-1");
    expect(result.total).toBe(1);
  });

  it("returns pinned notes first, then by recency", async () => {
    const n1 = store.create({ tenantId: "tenant-1", authorId: "admin-1", content: "Older unpinned" });
    await new Promise((r) => setTimeout(r, 10));
    const n2 = store.create({ tenantId: "tenant-1", authorId: "admin-1", content: "Newer unpinned" });
    await new Promise((r) => setTimeout(r, 10));
    const n3 = store.create({ tenantId: "tenant-1", authorId: "admin-1", content: "Pinned note", isPinned: true });

    const result = store.list({ tenantId: "tenant-1" });
    expect(result.entries).toHaveLength(3);
    // Pinned comes first
    expect(result.entries[0].id).toBe(n3.id);
    // Then newest unpinned
    expect(result.entries[1].id).toBe(n2.id);
    // Then older unpinned
    expect(result.entries[2].id).toBe(n1.id);
  });

  it("respects limit and offset pagination", () => {
    for (let i = 0; i < 5; i++) {
      store.create({ tenantId: "tenant-1", authorId: "admin-1", content: `Note ${i}` });
    }

    const page1 = store.list({ tenantId: "tenant-1", limit: 2, offset: 0 });
    expect(page1.entries).toHaveLength(2);
    expect(page1.total).toBe(5);

    const page2 = store.list({ tenantId: "tenant-1", limit: 2, offset: 2 });
    expect(page2.entries).toHaveLength(2);
    expect(page2.entries[0].id).not.toBe(page1.entries[0].id);
  });

  it("returns correct total count", () => {
    for (let i = 0; i < 7; i++) {
      store.create({ tenantId: "tenant-1", authorId: "admin-1", content: `Note ${i}` });
    }

    const result = store.list({ tenantId: "tenant-1", limit: 2 });
    expect(result.total).toBe(7);
    expect(result.entries).toHaveLength(2);
  });

  it("returns empty results when no notes exist", () => {
    const result = store.list({ tenantId: "nonexistent-tenant" });
    expect(result.entries).toHaveLength(0);
    expect(result.total).toBe(0);
  });
});

describe("AdminNotesStore.update", () => {
  let db: DrizzleDb;
  let sqlite: BetterSqlite3.Database;
  let store: AdminNotesStore;

  beforeEach(() => {
    const t = createTestDb();
    db = t.db;
    sqlite = t.sqlite;
    store = new AdminNotesStore(db);
  });

  afterEach(() => {
    sqlite.close();
  });

  it("modifies content", () => {
    const note = store.create({ tenantId: "tenant-1", authorId: "admin-1", content: "Original" });
    const updated = store.update(note.id, "tenant-1", { content: "Updated content" });

    expect(updated).not.toBeNull();
    expect(updated!.content).toBe("Updated content");
    expect(updated!.id).toBe(note.id);
  });

  it("toggles isPinned", () => {
    const note = store.create({ tenantId: "tenant-1", authorId: "admin-1", content: "Note", isPinned: false });
    const pinned = store.update(note.id, "tenant-1", { isPinned: true });

    expect(pinned).not.toBeNull();
    expect(pinned!.isPinned).toBe(true);

    const unpinned = store.update(note.id, "tenant-1", { isPinned: false });
    expect(unpinned!.isPinned).toBe(false);
  });

  it("returns null for non-existent noteId", () => {
    const result = store.update("nonexistent-id", "tenant-1", { content: "New content" });
    expect(result).toBeNull();
  });

  it("returns null when tenantId does not match", () => {
    const note = store.create({ tenantId: "tenant-1", authorId: "admin-1", content: "Note" });
    const result = store.update(note.id, "tenant-2", { content: "Hijacked" });
    expect(result).toBeNull();
  });
});

describe("AdminNotesStore.delete", () => {
  let db: DrizzleDb;
  let sqlite: BetterSqlite3.Database;
  let store: AdminNotesStore;

  beforeEach(() => {
    const t = createTestDb();
    db = t.db;
    sqlite = t.sqlite;
    store = new AdminNotesStore(db);
  });

  afterEach(() => {
    sqlite.close();
  });

  it("removes the note and returns true", () => {
    const note = store.create({ tenantId: "tenant-1", authorId: "admin-1", content: "Delete me" });
    const deleted = store.delete(note.id, "tenant-1");

    expect(deleted).toBe(true);
    const result = store.list({ tenantId: "tenant-1" });
    expect(result.entries).toHaveLength(0);
  });

  it("returns false for non-existent noteId", () => {
    const result = store.delete("nonexistent-id", "tenant-1");
    expect(result).toBe(false);
  });

  it("returns false when tenantId does not match", () => {
    const note = store.create({ tenantId: "tenant-1", authorId: "admin-1", content: "Delete me" });
    const result = store.delete(note.id, "tenant-2");
    expect(result).toBe(false);
    // Note should still exist
    const list = store.list({ tenantId: "tenant-1" });
    expect(list.entries).toHaveLength(1);
  });
});

describe("admin notes API routes", () => {
  let db: DrizzleDb;
  let sqlite: BetterSqlite3.Database;
  let store: AdminNotesStore;

  beforeEach(() => {
    const t = createTestDb();
    db = t.db;
    sqlite = t.sqlite;
    store = new AdminNotesStore(db);
  });

  afterEach(() => {
    sqlite.close();
  });

  it("GET /:tenantId returns notes", async () => {
    store.create({ tenantId: "tenant-1", authorId: "admin-1", content: "Note A" });
    store.create({ tenantId: "tenant-1", authorId: "admin-1", content: "Note B" });

    const app = new Hono();
    app.route("/admin/notes", createAdminNotesApiRoutes(db));

    const res = await app.request("/admin/notes/tenant-1");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.entries).toHaveLength(2);
    expect(body.total).toBe(2);
  });

  it("GET /:tenantId supports limit and offset", async () => {
    for (let i = 0; i < 5; i++) {
      store.create({ tenantId: "tenant-1", authorId: "admin-1", content: `Note ${i}` });
    }

    const app = new Hono();
    app.route("/admin/notes", createAdminNotesApiRoutes(db));

    const res = await app.request("/admin/notes/tenant-1?limit=2&offset=1");
    const body = await res.json();
    expect(body.entries).toHaveLength(2);
    expect(body.total).toBe(5);
  });

  it("POST /:tenantId creates a note", async () => {
    const app = new Hono();
    app.route("/admin/notes", createAdminNotesApiRoutes(db));

    const res = await app.request("/admin/notes/tenant-1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "New note", isPinned: false }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.content).toBe("New note");
    expect(body.tenantId).toBe("tenant-1");
  });

  it("POST /:tenantId returns 400 for missing content", async () => {
    const app = new Hono();
    app.route("/admin/notes", createAdminNotesApiRoutes(db));

    const res = await app.request("/admin/notes/tenant-1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("PATCH /:tenantId/:noteId updates a note", async () => {
    const note = store.create({ tenantId: "tenant-1", authorId: "admin-1", content: "Original" });

    const app = new Hono();
    app.route("/admin/notes", createAdminNotesApiRoutes(db));

    const res = await app.request(`/admin/notes/tenant-1/${note.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Updated" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.content).toBe("Updated");
  });

  it("PATCH /:tenantId/:noteId returns 403 for non-existent note", async () => {
    const app = new Hono();
    app.route("/admin/notes", createAdminNotesApiRoutes(db));

    const res = await app.request("/admin/notes/tenant-1/nonexistent", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Updated" }),
    });
    expect(res.status).toBe(403);
  });

  it("PATCH /:tenantId/:noteId returns 403 when tenantId does not match note owner", async () => {
    const note = store.create({ tenantId: "tenant-1", authorId: "admin-1", content: "Original" });

    const app = new Hono();
    app.route("/admin/notes", createAdminNotesApiRoutes(db));

    const res = await app.request(`/admin/notes/tenant-2/${note.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Hijacked" }),
    });
    expect(res.status).toBe(403);
  });

  it("DELETE /:tenantId/:noteId deletes a note", async () => {
    const note = store.create({ tenantId: "tenant-1", authorId: "admin-1", content: "Delete me" });

    const app = new Hono();
    app.route("/admin/notes", createAdminNotesApiRoutes(db));

    const res = await app.request(`/admin/notes/tenant-1/${note.id}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it("DELETE /:tenantId/:noteId returns 403 for non-existent note", async () => {
    const app = new Hono();
    app.route("/admin/notes", createAdminNotesApiRoutes(db));

    const res = await app.request("/admin/notes/tenant-1/nonexistent", {
      method: "DELETE",
    });
    expect(res.status).toBe(403);
  });

  it("DELETE /:tenantId/:noteId returns 403 when tenantId does not match note owner", async () => {
    const note = store.create({ tenantId: "tenant-1", authorId: "admin-1", content: "Delete me" });

    const app = new Hono();
    app.route("/admin/notes", createAdminNotesApiRoutes(db));

    const res = await app.request(`/admin/notes/tenant-2/${note.id}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(403);
  });
});
