import BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AdminNotesStore } from "./notes-store.js";
import { initAdminNotesSchema } from "./schema.js";

describe("AdminNotesStore", () => {
  let db: BetterSqlite3.Database;
  let store: AdminNotesStore;

  beforeEach(() => {
    db = new BetterSqlite3(":memory:");
    initAdminNotesSchema(db);
    store = new AdminNotesStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it("add() creates a note with correct fields", () => {
    const note = store.add("tenant-1", "admin@example.com", "Test note content");

    expect(note.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(note.tenant_id).toBe("tenant-1");
    expect(note.admin_user).toBe("admin@example.com");
    expect(note.content).toBe("Test note content");
    expect(note.created_at).toBeGreaterThan(0);
  });

  it("listForTenant() returns notes newest first", () => {
    store.add("tenant-1", "admin1", "First note");
    store.add("tenant-1", "admin2", "Second note");
    store.add("tenant-1", "admin1", "Third note");

    const notes = store.listForTenant("tenant-1");

    expect(notes).toHaveLength(3);
    expect(notes[0].content).toBe("Third note");
    expect(notes[1].content).toBe("Second note");
    expect(notes[2].content).toBe("First note");
  });

  it("listForTenant() respects limit", () => {
    for (let i = 0; i < 10; i++) {
      store.add("tenant-1", "admin", `Note ${i}`);
    }

    const notes = store.listForTenant("tenant-1", 3);
    expect(notes).toHaveLength(3);
  });

  it("listForTenant() does not cross-pollinate between tenants", () => {
    store.add("tenant-1", "admin", "Note for tenant 1");
    store.add("tenant-2", "admin", "Note for tenant 2");

    const t1Notes = store.listForTenant("tenant-1");
    const t2Notes = store.listForTenant("tenant-2");

    expect(t1Notes).toHaveLength(1);
    expect(t1Notes[0].content).toBe("Note for tenant 1");

    expect(t2Notes).toHaveLength(1);
    expect(t2Notes[0].content).toBe("Note for tenant 2");
  });

  it("listForTenant() returns empty array for tenant with no notes", () => {
    const notes = store.listForTenant("unknown-tenant");
    expect(notes).toEqual([]);
  });
});
