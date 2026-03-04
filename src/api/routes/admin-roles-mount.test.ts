import { describe, expect, it } from "vitest";
import { app } from "../app.js";

describe("admin-roles mount security (WOP-1607)", () => {
  it("GET /api/admin/roles/any-tenant returns 401 without auth", async () => {
    const res = await app.request("/api/admin/roles/any-tenant");
    expect(res.status).toBe(401);
  });

  it("PUT /api/admin/roles/any-tenant/any-user returns 401 without auth", async () => {
    const res = await app.request("/api/admin/roles/any-tenant/any-user", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "user" }),
    });
    expect(res.status).toBe(401);
  });

  it("DELETE /api/admin/roles/any-tenant/any-user returns 401 without auth", async () => {
    const res = await app.request("/api/admin/roles/any-tenant/any-user", {
      method: "DELETE",
    });
    expect(res.status).toBe(401);
  });

  it("GET /api/admin/platform-admins returns 401 without auth", async () => {
    const res = await app.request("/api/admin/platform-admins");
    expect(res.status).toBe(401);
  });

  it("POST /api/admin/platform-admins returns 401 without auth", async () => {
    const res = await app.request("/api/admin/platform-admins", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "someone" }),
    });
    expect(res.status).toBe(401);
  });

  it("DELETE /api/admin/platform-admins/any-user returns 401 without auth", async () => {
    const res = await app.request("/api/admin/platform-admins/any-user", {
      method: "DELETE",
    });
    expect(res.status).toBe(401);
  });
});
