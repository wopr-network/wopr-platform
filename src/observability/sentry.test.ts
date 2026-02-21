import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock @sentry/node before importing the module
vi.mock("@sentry/node", () => ({
  init: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  setTag: vi.fn(),
  setContext: vi.fn(),
}));

import * as Sentry from "@sentry/node";
import { captureError, captureMessage, initSentry } from "./sentry.js";

describe("sentry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not call Sentry.init when dsn is undefined", () => {
    initSentry(undefined);
    expect(Sentry.init).not.toHaveBeenCalled();
  });

  it("does not call Sentry.init when dsn is empty string", () => {
    initSentry("");
    expect(Sentry.init).not.toHaveBeenCalled();
  });

  it("calls Sentry.init with dsn when provided", () => {
    initSentry("https://abc@sentry.io/123");
    expect(Sentry.init).toHaveBeenCalledWith(expect.objectContaining({ dsn: "https://abc@sentry.io/123" }));
  });

  it("captureError calls Sentry.captureException", () => {
    initSentry("https://abc@sentry.io/123");
    const err = new Error("test");
    captureError(err, { orgId: "org-1" });
    expect(Sentry.captureException).toHaveBeenCalledWith(err, expect.anything());
  });

  it("captureError does not throw when sentry is not initialized", () => {
    initSentry(undefined);
    expect(() => captureError(new Error("test"))).not.toThrow();
  });

  it("captureMessage calls Sentry.captureMessage", () => {
    initSentry("https://abc@sentry.io/123");
    captureMessage("test message", "warning");
    expect(Sentry.captureMessage).toHaveBeenCalledWith("test message", "warning");
  });

  it("captureMessage does not throw when sentry is not initialized", () => {
    initSentry(undefined);
    expect(() => captureMessage("test")).not.toThrow();
  });
});
