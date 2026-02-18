import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decrypt, generateInstanceKey } from "./encryption.js";
import { forwardSecretsToInstance, writeEncryptedSeed } from "./key-injection.js";

describe("key-injection", () => {
  describe("writeEncryptedSeed", () => {
    let tmpDir: string;
    const key = generateInstanceKey();

    beforeEach(async () => {
      const { mkdtemp } = await import("node:fs/promises");
      tmpDir = await mkdtemp(path.join(os.tmpdir(), "wopr-test-"));
    });

    afterEach(async () => {
      const { rm } = await import("node:fs/promises");
      await rm(tmpDir, { recursive: true, force: true });
    });

    it("writes secrets.enc to the woprHome directory", async () => {
      const woprHome = path.join(tmpDir, "instance-1");
      const secrets = { ANTHROPIC_API_KEY: "sk-ant-test123" };

      await writeEncryptedSeed(woprHome, secrets, key);

      const seedPath = path.join(woprHome, "secrets.enc");
      const content = await readFile(seedPath, "utf-8");
      const payload = JSON.parse(content);

      expect(payload).toHaveProperty("iv");
      expect(payload).toHaveProperty("authTag");
      expect(payload).toHaveProperty("ciphertext");
    });

    it("encrypted seed can be decrypted back to original secrets", async () => {
      const woprHome = path.join(tmpDir, "instance-2");
      const secrets = { DISCORD_TOKEN: "token123", OPENAI_KEY: "sk-openai" };

      await writeEncryptedSeed(woprHome, secrets, key);

      const seedPath = path.join(woprHome, "secrets.enc");
      const content = await readFile(seedPath, "utf-8");
      const payload = JSON.parse(content);
      const decrypted = JSON.parse(decrypt(payload, key));

      expect(decrypted).toEqual(secrets);
    });

    it("creates directories recursively", async () => {
      const woprHome = path.join(tmpDir, "deep", "nested", "dir");
      await writeEncryptedSeed(woprHome, { KEY: "val" }, key);

      const content = await readFile(path.join(woprHome, "secrets.enc"), "utf-8");
      expect(JSON.parse(content)).toHaveProperty("ciphertext");
    });

    it("seed file does NOT contain plaintext key values", async () => {
      const woprHome = path.join(tmpDir, "instance-3");
      const secrets = { ANTHROPIC_API_KEY: "sk-ant-api0xxxxxxxxxxxxxxxxxxxx" };

      await writeEncryptedSeed(woprHome, secrets, key);

      const content = await readFile(path.join(woprHome, "secrets.enc"), "utf-8");
      expect(content).not.toContain("sk-ant-api0xxxxxxxxxxxxxxxxxxxx");
    });
  });

  describe("forwardSecretsToInstance", () => {
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
      globalThis.fetch = vi.fn();
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it("forwards body opaquely and returns ok on success", async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(new Response(null, { status: 200 }));

      const result = await forwardSecretsToInstance("http://container:3000", "session-token", '{"KEY":"val"}');

      expect(result.ok).toBe(true);
      expect(result.status).toBe(200);
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "http://container:3000/config/secrets",
        expect.objectContaining({
          method: "PUT",
          body: '{"KEY":"val"}',
          headers: expect.objectContaining({
            Authorization: "Bearer session-token",
          }),
        }),
      );
    });

    it("returns error on non-ok response", async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(new Response("Forbidden", { status: 403 }));

      const result = await forwardSecretsToInstance("http://container:3000", "token", "{}");

      expect(result.ok).toBe(false);
      expect(result.status).toBe(403);
      expect(result.error).toBe("Forbidden");
    });

    it("returns 502 on network error", async () => {
      vi.mocked(globalThis.fetch).mockRejectedValue(new Error("Connection refused"));

      const result = await forwardSecretsToInstance("http://container:3000", "token", "{}");

      expect(result.ok).toBe(false);
      expect(result.status).toBe(502);
      expect(result.error).toBe("Connection refused");
    });

    it("returns 502 with fallback message when thrown value is not an Error", async () => {
      vi.mocked(globalThis.fetch).mockRejectedValue("string error");

      const result = await forwardSecretsToInstance("http://container:3000", "token", "{}");

      expect(result.ok).toBe(false);
      expect(result.status).toBe(502);
      expect(result.error).toBe("Failed to forward secrets");
    });
  });
});
