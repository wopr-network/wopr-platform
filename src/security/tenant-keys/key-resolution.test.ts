import BetterSqlite3 from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encrypt, generateInstanceKey } from "../encryption.js";
import type { Provider } from "../types.js";
import { buildPooledKeysMap, resolveApiKey } from "./key-resolution.js";
import { TenantKeyStore } from "./schema.js";

function freshSqlite(): BetterSqlite3.Database {
  return new BetterSqlite3(":memory:");
}

describe("resolveApiKey", () => {
  let sqlite: BetterSqlite3.Database;
  let db: ReturnType<typeof drizzle>;
  let store: TenantKeyStore;
  let encryptionKey: Buffer;

  beforeEach(() => {
    sqlite = freshSqlite();
    store = new TenantKeyStore(sqlite);
    db = drizzle(sqlite);
    encryptionKey = generateInstanceKey();
  });

  afterEach(() => {
    sqlite.close();
  });

  it("returns tenant BYOK key when one is stored", () => {
    const encrypted = encrypt("sk-ant-tenant-key", encryptionKey);
    store.upsert("t1", "anthropic", encrypted);

    const pooled = new Map<Provider, string>([["anthropic", "sk-ant-pooled"]]);

    const result = resolveApiKey(db, "t1", "anthropic", encryptionKey, pooled);
    expect(result).not.toBeNull();
    expect(result?.key).toBe("sk-ant-tenant-key");
    expect(result?.source).toBe("tenant");
    expect(result?.provider).toBe("anthropic");
  });

  it("falls back to pooled key when no tenant key stored", () => {
    const pooled = new Map<Provider, string>([["openai", "sk-pooled-openai"]]);

    const result = resolveApiKey(db, "t1", "openai", encryptionKey, pooled);
    expect(result).not.toBeNull();
    expect(result?.key).toBe("sk-pooled-openai");
    expect(result?.source).toBe("pooled");
    expect(result?.provider).toBe("openai");
  });

  it("returns null when neither tenant nor pooled key exists", () => {
    const pooled = new Map<Provider, string>();
    const result = resolveApiKey(db, "t1", "anthropic", encryptionKey, pooled);
    expect(result).toBeNull();
  });

  it("resolves different providers independently", () => {
    const encrypted = encrypt("my-google-key", encryptionKey);
    store.upsert("t1", "google", encrypted);

    const pooled = new Map<Provider, string>([["anthropic", "sk-ant-pooled"]]);

    // Google: tenant key
    const googleResult = resolveApiKey(db, "t1", "google", encryptionKey, pooled);
    expect(googleResult?.source).toBe("tenant");
    expect(googleResult?.key).toBe("my-google-key");

    // Anthropic: pooled key
    const anthropicResult = resolveApiKey(db, "t1", "anthropic", encryptionKey, pooled);
    expect(anthropicResult?.source).toBe("pooled");
    expect(anthropicResult?.key).toBe("sk-ant-pooled");

    // Discord: none
    const discordResult = resolveApiKey(db, "t1", "discord", encryptionKey, pooled);
    expect(discordResult).toBeNull();
  });

  it("isolates keys between tenants", () => {
    const encrypted = encrypt("t1-anthropic-key", encryptionKey);
    store.upsert("t1", "anthropic", encrypted);

    const pooled = new Map<Provider, string>([["anthropic", "sk-ant-pooled"]]);

    // t1: tenant key
    const t1Result = resolveApiKey(db, "t1", "anthropic", encryptionKey, pooled);
    expect(t1Result?.source).toBe("tenant");

    // t2: pooled key (no tenant key stored)
    const t2Result = resolveApiKey(db, "t2", "anthropic", encryptionKey, pooled);
    expect(t2Result?.source).toBe("pooled");
  });
});

describe("buildPooledKeysMap", () => {
  it("reads keys from environment variables", () => {
    const env = {
      ANTHROPIC_API_KEY: "sk-ant-test",
      OPENAI_API_KEY: "sk-openai-test",
      GOOGLE_API_KEY: "google-test",
      DISCORD_BOT_TOKEN: "discord-test",
    };

    const keys = buildPooledKeysMap(env);
    expect(keys.get("anthropic")).toBe("sk-ant-test");
    expect(keys.get("openai")).toBe("sk-openai-test");
    expect(keys.get("google")).toBe("google-test");
    expect(keys.get("discord")).toBe("discord-test");
  });

  it("ignores missing env vars", () => {
    const keys = buildPooledKeysMap({});
    expect(keys.size).toBe(0);
  });

  it("trims whitespace from values", () => {
    const keys = buildPooledKeysMap({ ANTHROPIC_API_KEY: "  sk-ant-test  " });
    expect(keys.get("anthropic")).toBe("sk-ant-test");
  });

  it("ignores empty values", () => {
    const keys = buildPooledKeysMap({ ANTHROPIC_API_KEY: "  " });
    expect(keys.size).toBe(0);
  });
});
