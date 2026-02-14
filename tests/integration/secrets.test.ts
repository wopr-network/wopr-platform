/**
 * Integration tests for /api/instances/:id/config/secrets and /api/validate-key routes.
 *
 * Tests secrets endpoints through the full composed Hono app.
 * Key injection and validation are mocked (no real containers/providers).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUTH_HEADER,
  JSON_HEADERS,
  TENANT_A_TOKEN,
  TENANT_B_TOKEN,
  TEST_PLATFORM_SECRET,
  TEST_TOKEN,
  mockForwardSecretsToInstance,
  mockValidateProviderKey,
  mockWriteEncryptedSeed,
} from "./setup.js";

const { app } = await import("../../src/api/app.js");

describe("integration: secrets routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -- Authentication -------------------------------------------------------

  describe("auth middleware", () => {
    it("rejects /api/validate-key without token", async () => {
      const res = await app.request("/api/validate-key", { method: "POST" });
      expect(res.status).toBe(401);
    });

    it("rejects /api/instances/:id/config/secrets without token", async () => {
      const res = await app.request("/api/instances/inst-1/config/secrets", {
        method: "PUT",
        body: "{}",
      });
      expect(res.status).toBe(401);
    });
  });

  // -- PUT /api/instances/:id/config/secrets (proxy mode) -------------------

  describe("PUT .../config/secrets (proxy mode)", () => {
    it("forwards body to instance and returns ok", async () => {
      mockForwardSecretsToInstance.mockResolvedValue({ ok: true, status: 200 });

      const res = await app.request("/api/instances/inst-1/config/secrets", {
        method: "PUT",
        headers: JSON_HEADERS,
        body: '{"ANTHROPIC_API_KEY":"sk-ant-xxx"}',
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ ok: true, mode: "proxy" });
      expect(mockForwardSecretsToInstance).toHaveBeenCalledWith(
        "http://wopr-inst-1:3000",
        TEST_TOKEN,
        '{"ANTHROPIC_API_KEY":"sk-ant-xxx"}',
      );
    });

    it("returns error status when proxy fails", async () => {
      mockForwardSecretsToInstance.mockResolvedValue({
        ok: false,
        status: 502,
        error: "Connection refused",
      });

      const res = await app.request("/api/instances/inst-1/config/secrets", {
        method: "PUT",
        headers: JSON_HEADERS,
        body: '{"KEY":"val"}',
      });

      expect(res.status).toBe(502);
    });
  });

  // -- PUT /api/instances/:id/config/secrets (seed mode) --------------------

  describe("PUT .../config/secrets (seed mode)", () => {
    it("writes encrypted seed file", async () => {
      mockWriteEncryptedSeed.mockResolvedValue(undefined);

      const res = await app.request("/api/instances/inst-1/config/secrets?mode=seed", {
        method: "PUT",
        headers: JSON_HEADERS,
        body: JSON.stringify({ ANTHROPIC_API_KEY: "sk-ant-xxx" }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ ok: true, mode: "seed" });
    });

    it("returns 400 for invalid JSON", async () => {
      const res = await app.request("/api/instances/inst-1/config/secrets?mode=seed", {
        method: "PUT",
        headers: JSON_HEADERS,
        body: "not json",
      });
      expect(res.status).toBe(400);
    });

    it("returns 500 when seed write fails", async () => {
      mockWriteEncryptedSeed.mockRejectedValue(new Error("Disk full"));

      const res = await app.request("/api/instances/inst-1/config/secrets?mode=seed", {
        method: "PUT",
        headers: JSON_HEADERS,
        body: JSON.stringify({ KEY: "val" }),
      });
      expect(res.status).toBe(500);
    });
  });

  // -- Instance ID validation -----------------------------------------------

  describe("instance ID validation", () => {
    it("rejects invalid instance ID", async () => {
      const res = await app.request("/api/instances/bad%20id/config/secrets?mode=seed", {
        method: "PUT",
        headers: JSON_HEADERS,
        body: JSON.stringify({ KEY: "val" }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("Invalid instance ID");
    });
  });

  // -- POST /api/validate-key -----------------------------------------------

  describe("POST /api/validate-key", () => {
    it("validates a key and returns result", async () => {
      mockValidateProviderKey.mockResolvedValue({ valid: true });

      const { deriveInstanceKey, encrypt } = await import("../../src/security/encryption.js");
      const instanceKey = deriveInstanceKey("inst-1", TEST_PLATFORM_SECRET);
      const encryptedPayload = encrypt("sk-ant-valid-key", instanceKey);

      const res = await app.request("/api/validate-key?instanceId=inst-1", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          provider: "anthropic",
          encryptedKey: JSON.stringify(encryptedPayload),
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.valid).toBe(true);
      expect(mockValidateProviderKey).toHaveBeenCalledWith("anthropic", "sk-ant-valid-key");
    });

    it("rejects missing instanceId query parameter", async () => {
      const { deriveInstanceKey, encrypt } = await import("../../src/security/encryption.js");
      const instanceKey = deriveInstanceKey("inst-1", TEST_PLATFORM_SECRET);
      const encryptedPayload = encrypt("test", instanceKey);

      const res = await app.request("/api/validate-key", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          provider: "anthropic",
          encryptedKey: JSON.stringify(encryptedPayload),
        }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("instanceId");
    });

    it("returns 400 for invalid JSON body", async () => {
      const res = await app.request("/api/validate-key?instanceId=inst-1", {
        method: "POST",
        headers: JSON_HEADERS,
        body: "not json",
      });
      expect(res.status).toBe(400);
    });

    it("returns 400 when encrypted key cannot be decrypted", async () => {
      const res = await app.request("/api/validate-key?instanceId=inst-1", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          provider: "openai",
          encryptedKey: '{"iv":"bad","authTag":"bad","ciphertext":"bad"}',
        }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("decrypt");
    });
  });

});
