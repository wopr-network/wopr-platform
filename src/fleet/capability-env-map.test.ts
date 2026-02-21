import { describe, expect, it } from "vitest";
import { CAPABILITY_ENV_MAP, lookupCapabilityEnv } from "./capability-env-map.js";

describe("capability-env-map", () => {
  it("maps tts to ELEVENLABS_API_KEY", () => {
    const entry = lookupCapabilityEnv("tts");
    expect(entry).toEqual({ envKey: "ELEVENLABS_API_KEY", vaultProvider: "elevenlabs" });
  });

  it("maps stt to DEEPGRAM_API_KEY", () => {
    const entry = lookupCapabilityEnv("stt");
    expect(entry).toEqual({ envKey: "DEEPGRAM_API_KEY", vaultProvider: "deepgram" });
  });

  it("maps llm to OPENROUTER_API_KEY", () => {
    const entry = lookupCapabilityEnv("llm");
    expect(entry).toEqual({ envKey: "OPENROUTER_API_KEY", vaultProvider: "openrouter" });
  });

  it("maps image-gen to REPLICATE_API_TOKEN", () => {
    const entry = lookupCapabilityEnv("image-gen");
    expect(entry).toEqual({ envKey: "REPLICATE_API_TOKEN", vaultProvider: "replicate" });
  });

  it("maps embeddings to OPENROUTER_API_KEY", () => {
    const entry = lookupCapabilityEnv("embeddings");
    expect(entry).toEqual({ envKey: "OPENROUTER_API_KEY", vaultProvider: "openrouter" });
  });

  it("returns null for unknown capability", () => {
    expect(lookupCapabilityEnv("unknown-cap")).toBeNull();
  });

  it("CAPABILITY_ENV_MAP has at least 5 entries", () => {
    expect(Object.keys(CAPABILITY_ENV_MAP).length).toBeGreaterThanOrEqual(5);
  });
});
