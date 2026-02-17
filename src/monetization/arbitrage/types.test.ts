import { describe, expect, it } from "vitest";
import { NoProviderAvailableError } from "./types.js";

describe("NoProviderAvailableError", () => {
  it("has correct name property", () => {
    const err = new NoProviderAvailableError("tts");
    expect(err.name).toBe("NoProviderAvailableError");
  });

  it("has correct capability property", () => {
    const err = new NoProviderAvailableError("tts");
    expect(err.capability).toBe("tts");
  });

  it("has httpStatus 503", () => {
    const err = new NoProviderAvailableError("tts");
    expect(err.httpStatus).toBe(503);
  });

  it("message includes the capability name", () => {
    const err = new NoProviderAvailableError("image-generation");
    expect(err.message).toContain("image-generation");
  });

  it("is an instance of Error", () => {
    const err = new NoProviderAvailableError("tts");
    expect(err).toBeInstanceOf(Error);
  });
});
