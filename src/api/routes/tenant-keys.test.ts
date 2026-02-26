import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DrizzleDb } from "../../db/index.js";
import { TenantKeyStore } from "../../security/tenant-keys/schema.js";
import { createTestDb } from "../../test/db.js";

const TEST_TENANT = "ACME";
const TEST_TOKEN = `write:wopr_write_test123`;
const TENANT_TOKEN = "wopr_write_test123";

vi.stubEnv(`FLEET_TOKEN_${TEST_TENANT}`, TEST_TOKEN);
vi.stubEnv("PLATFORM_SECRET", "test-platform-secret-32bytes!!ok");

const authHeader = { Authorization: `Bearer ${TENANT_TOKEN}` };

const { tenantKeyRoutes, setStore } = await import("./tenant-keys.js");

const app = new Hono();
app.route("/api/tenant-keys", tenantKeyRoutes);

describe("tenant-keys routes", () => {
  let db: DrizzleDb;
  let store: TenantKeyStore;

  beforeEach(async () => {
    ({ db } = await createTestDb());
    store = new TenantKeyStore(db);
    setStore(store);
  });

  afterEach(() => {
    // PGlite cleans up automatically
  });

  describe("authentication", () => {
    it("rejects requests without bearer token", async () => {
      const res = await app.request("/api/tenant-keys", { method: "GET" });
      expect(res.status).toBe(401);
    });

    it("rejects requests with invalid token", async () => {
      const res = await app.request("/api/tenant-keys", {
        method: "GET",
        headers: { Authorization: "Bearer bad-token" },
      });
      expect(res.status).toBe(401);
    });
  });

  describe("PUT /api/tenant-keys/:provider", () => {
    it("stores a new key and returns ok", async () => {
      const res = await app.request("/api/tenant-keys/anthropic", {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({
          provider: "anthropic",
          apiKey: "sk-ant-my-secret-key",
          label: "My Anthropic Key",
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.provider).toBe("anthropic");
      expect(body.id).toBeTruthy();

      // Verify stored in DB
      const record = await store.get(TEST_TENANT, "anthropic");
      expect(record).toBeDefined();
      expect(record?.label).toBe("My Anthropic Key");
    });

    it("updates an existing key", async () => {
      // Store initial key
      await app.request("/api/tenant-keys/openai", {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({ provider: "openai", apiKey: "sk-old-key" }),
      });

      // Update it
      const res = await app.request("/api/tenant-keys/openai", {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({ provider: "openai", apiKey: "sk-new-key", label: "Updated" }),
      });

      expect(res.status).toBe(200);
      const record = await store.get(TEST_TENANT, "openai");
      expect(record?.label).toBe("Updated");
    });

    it("rejects invalid provider", async () => {
      const res = await app.request("/api/tenant-keys/invalid-provider", {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({ provider: "invalid-provider", apiKey: "key" }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("Invalid provider");
    });

    it("rejects mismatched provider in body vs URL", async () => {
      const res = await app.request("/api/tenant-keys/anthropic", {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({ provider: "openai", apiKey: "key" }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("must match");
    });

    it("rejects empty apiKey", async () => {
      const res = await app.request("/api/tenant-keys/anthropic", {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({ provider: "anthropic", apiKey: "" }),
      });

      expect(res.status).toBe(400);
    });

    it("rejects invalid JSON body", async () => {
      const res = await app.request("/api/tenant-keys/anthropic", {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: "not json",
      });

      expect(res.status).toBe(400);
    });
  });

  describe("GET /api/tenant-keys", () => {
    it("returns empty array when no keys stored", async () => {
      const res = await app.request("/api/tenant-keys", {
        method: "GET",
        headers: authHeader,
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.keys).toEqual([]);
    });

    it("returns metadata for stored keys", async () => {
      // Store a key
      await app.request("/api/tenant-keys/anthropic", {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({ provider: "anthropic", apiKey: "sk-ant-xxx", label: "Test" }),
      });

      const res = await app.request("/api/tenant-keys", {
        method: "GET",
        headers: authHeader,
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.keys).toHaveLength(1);
      expect(body.keys[0].provider).toBe("anthropic");
      expect(body.keys[0].label).toBe("Test");
      // Should NOT contain the encrypted key
      expect(body.keys[0]).not.toHaveProperty("encrypted_key");
    });
  });

  describe("GET /api/tenant-keys/:provider", () => {
    it("returns 404 when no key stored", async () => {
      const res = await app.request("/api/tenant-keys/anthropic", {
        method: "GET",
        headers: authHeader,
      });

      expect(res.status).toBe(404);
    });

    it("returns metadata for a stored key", async () => {
      await app.request("/api/tenant-keys/anthropic", {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({ provider: "anthropic", apiKey: "sk-ant-xxx", label: "My Key" }),
      });

      const res = await app.request("/api/tenant-keys/anthropic", {
        method: "GET",
        headers: authHeader,
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.provider).toBe("anthropic");
      expect(body.label).toBe("My Key");
      expect(body).not.toHaveProperty("encrypted_key");
    });

    it("rejects invalid provider", async () => {
      const res = await app.request("/api/tenant-keys/bad-provider", {
        method: "GET",
        headers: authHeader,
      });

      expect(res.status).toBe(400);
    });
  });

  describe("DELETE /api/tenant-keys/:provider", () => {
    it("returns 404 when no key stored", async () => {
      const res = await app.request("/api/tenant-keys/anthropic", {
        method: "DELETE",
        headers: authHeader,
      });

      expect(res.status).toBe(404);
    });

    it("deletes a stored key", async () => {
      // Store first
      await app.request("/api/tenant-keys/anthropic", {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({ provider: "anthropic", apiKey: "sk-ant-xxx" }),
      });

      // Delete
      const res = await app.request("/api/tenant-keys/anthropic", {
        method: "DELETE",
        headers: authHeader,
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);

      // Verify gone
      expect(await store.get(TEST_TENANT, "anthropic")).toBeUndefined();
    });

    it("rejects invalid provider", async () => {
      const res = await app.request("/api/tenant-keys/bad-provider", {
        method: "DELETE",
        headers: authHeader,
      });

      expect(res.status).toBe(400);
    });
  });
});
