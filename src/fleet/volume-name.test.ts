import { describe, expect, it } from "vitest";
import { dockerVolumeNameSchema } from "./types.js";

describe("dockerVolumeNameSchema", () => {
  // --- Valid names ---

  const validNames = [
    "myvolume",
    "my-volume",
    "my_volume",
    "my.volume",
    "Volume1",
    "a",
    "data-vol-3.2",
    "ALLCAPS",
    "wopr-bot-data",
    "123numeric",
  ];

  for (const name of validNames) {
    it(`accepts valid volume name: "${name}"`, () => {
      expect(dockerVolumeNameSchema.parse(name)).toBe(name);
    });
  }

  // --- Host path rejection ---

  const hostPaths = ["/etc", "/var/run/docker.sock", "/home/user", "/", "/tmp/evil", "/root/.ssh"];

  for (const path of hostPaths) {
    it(`rejects host path: "${path}"`, () => {
      expect(() => dockerVolumeNameSchema.parse(path)).toThrow();
    });
  }

  // --- Path traversal rejection ---

  const traversalNames = ["..", "../etc", "vol/../escape", "a.."];

  for (const name of traversalNames) {
    it(`rejects path traversal: "${name}"`, () => {
      expect(() => dockerVolumeNameSchema.parse(name)).toThrow();
    });
  }

  // --- Other invalid names ---

  const invalidNames = [
    "", // empty string
    ".hidden", // starts with dot
    "-dashed", // starts with dash
    "_under", // starts with underscore
    "has space", // contains space
    "has/slash", // contains forward slash
    "has:colon", // contains colon
    "has@at", // contains special char
  ];

  for (const name of invalidNames) {
    it(`rejects invalid volume name: "${name}"`, () => {
      expect(() => dockerVolumeNameSchema.parse(name)).toThrow();
    });
  }
});
