import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { encrypt } from "../../security/encryption.js";

const TEST_TOKEN = "test-api-token";
const TEST_PLATFORM_SECRET = "test-platform-secret-32bytes!!ok";

vi.stubEnv("FLEET_API_TOKEN", TEST_TOKEN);
vi.stubEnv("PLATFORM_SECRET", TEST_PLATFORM_SECRET);
vi.stubEnv("INSTANCE_DATA_DIR", "/tmp/wopr-test-instances");

const authHeader = { Authorization: `Bearer ${TEST_TOKEN}` };

// Mock key-injection module
const mockWriteEncryptedSeed = vi.fn();
const mockForwardSecretsToInstance = vi.fn();

vi.mock("../../security/key-injection.js", () => ({
  writeEncryptedSeed: (...args: unknown[]) => mockWriteEncryptedSeed(...args),
  forwardSecretsToInstance: (...args: unknown[]) => mockForwardSecretsToInstance(...args),
}));

// Mock key-validation module
const mockValidateProviderKey = vi.fn();

vi.mock("../../security/key-validation.js", () => ({
  validateProviderKey: (...args: unknown[]) => mockValidateProviderKey(...args),
}));

const { secretsRoutes } = await import("./secrets.js");

const app = new Hono();
app.route("/api", secretsRoutes);

describe("secrets routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("authentication", () => {
    it("rejects requests without bearer token", async () => {
      const res = await app.request("/api/validate-key", { method: "POST" });
      expect(res.status).toBe(401);
    });

    it("rejects requests with wrong token", async () => {
      const res = await app.request("/api/validate-key", {
        method: "POST",
        headers: { Authorization: "Bearer wrong" },
      });
      expect(res.status).toBe(401);
    });
  });

  describe("PUT /api/instances/:id/config/secrets (proxy mode)", () => {
    it("forwards body to instance and returns ok", async () => {
      mockForwardSecretsToInstance.mockResolvedValue({ ok: true, status: 200 });

      const res = await app.request("/api/instances/inst-1/config/secrets", {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...authHeader },
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

    it("returns error when proxy fails", async () => {
      mockForwardSecretsToInstance.mockResolvedValue({ ok: false, status: 502, error: "Connection refused" });

      const res = await app.request("/api/instances/inst-1/config/secrets", {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: '{"KEY":"val"}',
      });

      expect(res.status).toBe(502);
      const body = await res.json();
      expect(body.error).toBe("Connection refused");
    });
  });

  describe("PUT /api/instances/:id/config/secrets (seed mode)", () => {
    it("writes encrypted seed file", async () => {
      mockWriteEncryptedSeed.mockResolvedValue({ iv: "aa", authTag: "bb", ciphertext: "cc" });

      const res = await app.request("/api/instances/inst-1/config/secrets?mode=seed", {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({ ANTHROPIC_API_KEY: "sk-ant-xxx" }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ ok: true, mode: "seed" });
      expect(mockWriteEncryptedSeed).toHaveBeenCalledWith(
        "/tmp/wopr-test-instances/inst-1",
        { ANTHROPIC_API_KEY: "sk-ant-xxx" },
        expect.any(Buffer),
      );
    });

    it("rejects empty secrets object", async () => {
      const res = await app.request("/api/instances/inst-1/config/secrets?mode=seed", {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
    });

    it("rejects invalid JSON body", async () => {
      const res = await app.request("/api/instances/inst-1/config/secrets?mode=seed", {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: "not json",
      });

      expect(res.status).toBe(400);
    });

    it("returns 500 when seed write fails", async () => {
      mockWriteEncryptedSeed.mockRejectedValue(new Error("Disk full"));

      const res = await app.request("/api/instances/inst-1/config/secrets?mode=seed", {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({ KEY: "val" }),
      });

      expect(res.status).toBe(500);
    });
  });

  describe("POST /api/validate-key", () => {
    it("validates a key and returns result", async () => {
      mockValidateProviderKey.mockResolvedValue({ valid: true });

      // Encrypt a test key using the instance-derived key
      const { deriveInstanceKey } = await import("../../security/encryption.js");
      const instanceKey = deriveInstanceKey("inst-1", TEST_PLATFORM_SECRET);
      const encryptedPayload = encrypt("sk-ant-valid-key", instanceKey);

      const res = await app.request("/api/validate-key?instanceId=inst-1", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader },
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

    it("returns invalid for bad key", async () => {
      mockValidateProviderKey.mockResolvedValue({ valid: false, error: "Invalid API key" });

      const { deriveInstanceKey } = await import("../../security/encryption.js");
      const instanceKey = deriveInstanceKey("inst-1", TEST_PLATFORM_SECRET);
      const encryptedPayload = encrypt("sk-ant-bad-key", instanceKey);

      const res = await app.request("/api/validate-key?instanceId=inst-1", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({
          provider: "anthropic",
          encryptedKey: JSON.stringify(encryptedPayload),
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.valid).toBe(false);
      expect(body.error).toBe("Invalid API key");
    });

    it("rejects missing instanceId query param", async () => {
      const { deriveInstanceKey } = await import("../../security/encryption.js");
      const instanceKey = deriveInstanceKey("inst-1", TEST_PLATFORM_SECRET);
      const encryptedPayload = encrypt("test", instanceKey);

      const res = await app.request("/api/validate-key", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({
          provider: "anthropic",
          encryptedKey: JSON.stringify(encryptedPayload),
        }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("instanceId");
    });

    it("rejects invalid provider", async () => {
      const res = await app.request("/api/validate-key?instanceId=inst-1", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({
          provider: "invalid-provider",
          encryptedKey: "some-encrypted-data",
        }),
      });

      expect(res.status).toBe(400);
    });

    it("rejects invalid JSON body", async () => {
      const res = await app.request("/api/validate-key?instanceId=inst-1", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: "not json",
      });

      expect(res.status).toBe(400);
    });

    it("returns 400 when encrypted key cannot be decrypted", async () => {
      const res = await app.request("/api/validate-key?instanceId=inst-1", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader },
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
