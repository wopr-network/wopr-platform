/**
 * tRPC capabilities router tests — WOP-915
 *
 * Tests for listCapabilitySettings and updateCapabilitySettings procedures.
 */

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CapabilitySettingsStore } from "../../security/tenant-keys/capability-settings-store.js";
import { TenantKeyStore } from "../../security/tenant-keys/schema.js";
import { appRouter } from "../index.js";
import type { TRPCContext } from "../init.js";
import { setCapabilitiesRouterDeps } from "./capabilities.js";

function ctxForTenant(tenantId: string): TRPCContext {
  return {
    user: { id: `user-${tenantId}`, roles: ["user"] },
    tenantId,
  };
}

const TENANT = "tenant-test-915";

describe("capabilities.listCapabilitySettings", () => {
  let db: Database.Database;
  let keyStore: TenantKeyStore;
  let capStore: CapabilitySettingsStore;

  beforeEach(() => {
    db = new Database(":memory:");
    keyStore = new TenantKeyStore(db);
    capStore = new CapabilitySettingsStore(db);

    setCapabilitiesRouterDeps({
      getTenantKeyStore: () => keyStore,
      getCapabilitySettingsStore: () => capStore,
      encrypt: (plaintext: string) => ({ ciphertext: `enc:${plaintext}`, iv: "test-iv", authTag: "tag" }),
      deriveTenantKey: (_tenantId: string, _secret: string) => Buffer.alloc(32),
      platformSecret: "test-platform-secret-32bytes!!ok",
      validateProviderKey: async () => ({ valid: true }),
    });
  });

  afterEach(() => {
    db.close();
  });

  it("returns all 4 capabilities defaulting to hosted when no settings stored", async () => {
    const caller = appRouter.createCaller(ctxForTenant(TENANT));
    const result = await caller.capabilities.listCapabilitySettings();

    expect(result).toHaveLength(4);
    const capabilities = result.map((r) => r.capability);
    expect(capabilities).toContain("transcription");
    expect(capabilities).toContain("image-gen");
    expect(capabilities).toContain("text-gen");
    expect(capabilities).toContain("embeddings");

    for (const item of result) {
      expect(item.mode).toBe("hosted");
      expect(item.maskedKey).toBeNull();
      expect(item.keyStatus).toBeNull();
    }
  });

  it("returns byok mode with masked key when key is stored and mode is byok", async () => {
    keyStore.upsert(TENANT, "openai", { ciphertext: "enc:sk-test", iv: "iv", authTag: "tag" }, "...1234");
    capStore.upsert(TENANT, "text-gen", "byok");

    const caller = appRouter.createCaller(ctxForTenant(TENANT));
    const result = await caller.capabilities.listCapabilitySettings();

    const textGen = result.find((r) => r.capability === "text-gen");
    expect(textGen).toBeDefined();
    expect(textGen!.mode).toBe("byok");
    expect(textGen!.maskedKey).toBe("...1234");
    expect(textGen!.keyStatus).toBe("unchecked");
  });

  it("returns hosted mode even when key exists if mode preference is hosted", async () => {
    keyStore.upsert(TENANT, "openai", { ciphertext: "enc:sk-test", iv: "iv", authTag: "tag" }, "...5678");
    // Do NOT set mode — defaults to hosted

    const caller = appRouter.createCaller(ctxForTenant(TENANT));
    const result = await caller.capabilities.listCapabilitySettings();

    const textGen = result.find((r) => r.capability === "text-gen");
    expect(textGen).toBeDefined();
    expect(textGen!.mode).toBe("hosted");
    expect(textGen!.maskedKey).toBeNull();
    expect(textGen!.keyStatus).toBeNull();
  });

  it("returns null provider for hosted-only capabilities", async () => {
    const caller = appRouter.createCaller(ctxForTenant(TENANT));
    const result = await caller.capabilities.listCapabilitySettings();

    const transcription = result.find((r) => r.capability === "transcription");
    const imageGen = result.find((r) => r.capability === "image-gen");
    expect(transcription!.provider).toBeNull();
    expect(imageGen!.provider).toBeNull();
  });

  it("isolates settings between tenants", async () => {
    const OTHER_TENANT = "tenant-other";
    capStore.upsert(OTHER_TENANT, "text-gen", "byok");
    keyStore.upsert(OTHER_TENANT, "openai", { ciphertext: "enc:other-key", iv: "iv", authTag: "tag" }, "...9999");

    const caller = appRouter.createCaller(ctxForTenant(TENANT));
    const result = await caller.capabilities.listCapabilitySettings();

    const textGen = result.find((r) => r.capability === "text-gen");
    expect(textGen?.mode).toBe("hosted");
    expect(textGen?.maskedKey).toBeNull();
  });
});

describe("capabilities.updateCapabilitySettings", () => {
  let db: Database.Database;
  let keyStore: TenantKeyStore;
  let capStore: CapabilitySettingsStore;

  beforeEach(() => {
    db = new Database(":memory:");
    keyStore = new TenantKeyStore(db);
    capStore = new CapabilitySettingsStore(db);

    setCapabilitiesRouterDeps({
      getTenantKeyStore: () => keyStore,
      getCapabilitySettingsStore: () => capStore,
      encrypt: (plaintext: string) => ({ ciphertext: `enc:${plaintext}`, iv: "test-iv", authTag: "tag" }),
      deriveTenantKey: (_tenantId: string, _secret: string) => Buffer.alloc(32),
      platformSecret: "test-platform-secret-32bytes!!ok",
      validateProviderKey: async () => ({ valid: true }),
    });
  });

  afterEach(() => {
    db.close();
  });

  it("updates mode to byok for text-gen", async () => {
    const caller = appRouter.createCaller(ctxForTenant(TENANT));
    const result = await caller.capabilities.updateCapabilitySettings({
      capability: "text-gen",
      mode: "byok",
    });

    expect(result.capability).toBe("text-gen");
    expect(result.mode).toBe("byok");
  });

  it("stores key and returns masked key when switching to byok with a key", async () => {
    const caller = appRouter.createCaller(ctxForTenant(TENANT));
    const result = await caller.capabilities.updateCapabilitySettings({
      capability: "text-gen",
      mode: "byok",
      key: "sk-openai-test1234",
    });

    expect(result.mode).toBe("byok");
    expect(result.maskedKey).toBe("...1234");
    expect(result.keyStatus).toBe("unchecked");

    // Verify key was stored
    const stored = keyStore.get(TENANT, "openai");
    expect(stored).toBeDefined();
  });

  it("rejects byok for transcription (hosted-only capability)", async () => {
    const caller = appRouter.createCaller(ctxForTenant(TENANT));
    await expect(
      caller.capabilities.updateCapabilitySettings({
        capability: "transcription",
        mode: "byok",
      }),
    ).rejects.toThrow("transcription does not support BYOK mode");
  });

  it("rejects byok for image-gen (hosted-only capability)", async () => {
    const caller = appRouter.createCaller(ctxForTenant(TENANT));
    await expect(
      caller.capabilities.updateCapabilitySettings({
        capability: "image-gen",
        mode: "byok",
      }),
    ).rejects.toThrow("image-gen does not support BYOK mode");
  });

  it("allows switching back to hosted", async () => {
    capStore.upsert(TENANT, "text-gen", "byok");

    const caller = appRouter.createCaller(ctxForTenant(TENANT));
    const result = await caller.capabilities.updateCapabilitySettings({
      capability: "text-gen",
      mode: "hosted",
    });

    expect(result.mode).toBe("hosted");
    expect(result.maskedKey).toBeNull();
    expect(result.keyStatus).toBeNull();
  });
});
