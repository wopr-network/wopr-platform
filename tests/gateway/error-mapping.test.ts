import { describe, expect, it } from "vitest";
import { mapProviderError } from "../../src/gateway/error-mapping.js";

describe("mapProviderError", () => {
  it("maps rate limit errors (429) to rate_limit_error", () => {
    const err = Object.assign(new Error("rate limited"), { httpStatus: 429 });
    const result = mapProviderError(err, "openrouter");
    expect(result.status).toBe(429);
    expect(result.body.error.type).toBe("rate_limit_error");
    expect(result.body.error.code).toBe("rate_limit_exceeded");
  });

  it("maps 503 errors to service_unavailable", () => {
    const err = Object.assign(new Error("service down"), { httpStatus: 503 });
    const result = mapProviderError(err, "deepgram");
    expect(result.status).toBe(503);
    expect(result.body.error.code).toBe("service_unavailable");
  });

  it("maps 4xx errors to upstream_error with status preserved", () => {
    const err = Object.assign(new Error("bad request"), { httpStatus: 400 });
    const result = mapProviderError(err, "elevenlabs");
    expect(result.status).toBe(400);
    expect(result.body.error.type).toBe("upstream_error");
    expect(result.body.error.message).toContain("elevenlabs");
  });

  it("maps unknown errors to 502 Bad Gateway", () => {
    const result = mapProviderError(new Error("something broke"), "replicate");
    expect(result.status).toBe(502);
    expect(result.body.error.type).toBe("server_error");
    expect(result.body.error.code).toBe("upstream_error");
  });

  it("handles non-Error values", () => {
    const result = mapProviderError("string error", "twilio");
    expect(result.status).toBe(502);
    expect(result.body.error.type).toBe("server_error");
  });
});
