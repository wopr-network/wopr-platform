import { describe, expect, it } from "vitest";
import { captureError, initSentry, tagSentryContext } from "./sentry.js";

describe("Sentry helpers", () => {
  it("initSentry does not throw when SENTRY_DSN is undefined", () => {
    const original = process.env.SENTRY_DSN;
    delete process.env.SENTRY_DSN;
    expect(() => initSentry()).not.toThrow();
    process.env.SENTRY_DSN = original;
  });

  it("captureError does not throw when Sentry is not initialized", () => {
    expect(() => captureError(new Error("test error"))).not.toThrow();
  });

  it("captureError does not throw with non-Error value", () => {
    expect(() => captureError("string error")).not.toThrow();
    expect(() => captureError(null)).not.toThrow();
    expect(() => captureError(undefined)).not.toThrow();
  });

  it("captureError does not throw with context", () => {
    expect(() =>
      captureError(new Error("test"), {
        orgId: "org-1",
        instanceId: "inst-1",
        route: "/api/test",
        extra: { key: "value" },
      }),
    ).not.toThrow();
  });

  it("tagSentryContext does not throw when Sentry is not initialized", () => {
    expect(() => tagSentryContext({ orgId: "org-1", route: "/test" })).not.toThrow();
  });

  it("tagSentryContext does not throw with empty tags", () => {
    expect(() => tagSentryContext({})).not.toThrow();
  });
});
