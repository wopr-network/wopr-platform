import { describe, expect, it } from "vitest";
import type { PluginManifest } from "../api/routes/marketplace-registry.js";
import { detectCapabilityConflicts } from "./capability-conflict.js";

const fakeRegistry: Pick<PluginManifest, "id" | "capabilities">[] = [
  { id: "elevenlabs-tts", capabilities: ["voice", "tts"] },
  { id: "deepgram-stt", capabilities: ["voice", "stt"] },
  { id: "discord-channel", capabilities: ["channel"] },
  { id: "another-tts", capabilities: ["tts", "audio"] },
];

describe("detectCapabilityConflicts", () => {
  it("returns empty array when no conflicts", () => {
    const conflicts = detectCapabilityConflicts(
      "discord-channel",
      ["elevenlabs-tts"],
      fakeRegistry as PluginManifest[],
    );
    expect(conflicts).toEqual([]);
  });

  it("detects single capability conflict", () => {
    const conflicts = detectCapabilityConflicts("another-tts", ["elevenlabs-tts"], fakeRegistry as PluginManifest[]);
    expect(conflicts).toEqual([{ capability: "tts", existingPluginId: "elevenlabs-tts", newPluginId: "another-tts" }]);
  });

  it("detects multiple capability conflicts", () => {
    const conflicts = detectCapabilityConflicts("deepgram-stt", ["elevenlabs-tts"], fakeRegistry as PluginManifest[]);
    expect(conflicts).toEqual([
      { capability: "voice", existingPluginId: "elevenlabs-tts", newPluginId: "deepgram-stt" },
    ]);
  });

  it("returns empty when new plugin not in registry", () => {
    const conflicts = detectCapabilityConflicts("unknown-plugin", ["elevenlabs-tts"], fakeRegistry as PluginManifest[]);
    expect(conflicts).toEqual([]);
  });

  it("returns empty when no plugins installed", () => {
    const conflicts = detectCapabilityConflicts("elevenlabs-tts", [], fakeRegistry as PluginManifest[]);
    expect(conflicts).toEqual([]);
  });

  it("ignores disabled/uninstalled plugins not in installedIds", () => {
    const conflicts = detectCapabilityConflicts("another-tts", ["discord-channel"], fakeRegistry as PluginManifest[]);
    expect(conflicts).toEqual([]);
  });
});
