import { describe, expect, it } from "vitest";
import { checkHealth } from "./self-hosted-base.js";

describe("checkHealth", () => {
  it("returns true when fetch responds with 200", async () => {
    const mockFetch = async () => new Response(null, { status: 200 });
    const result = await checkHealth("http://localhost:8000", "/health", mockFetch);
    expect(result).toBe(true);
  });

  it("returns true for any 2xx status", async () => {
    const mockFetch = async () => new Response(null, { status: 204 });
    const result = await checkHealth("http://localhost:8000", "/health", mockFetch);
    expect(result).toBe(true);
  });

  it("returns false when fetch responds with non-2xx status", async () => {
    const mockFetch = async () => new Response(null, { status: 503 });
    const result = await checkHealth("http://localhost:8000", "/health", mockFetch);
    expect(result).toBe(false);
  });

  it("returns false when fetch throws a network error", async () => {
    const mockFetch = async (): Promise<Response> => {
      throw new Error("ECONNREFUSED");
    };
    const result = await checkHealth("http://localhost:8000", "/health", mockFetch);
    expect(result).toBe(false);
  });

  it("uses /health as default healthPath", async () => {
    let calledUrl = "";
    const mockFetch = async (url: string) => {
      calledUrl = url;
      return new Response(null, { status: 200 });
    };
    await checkHealth("http://gpu:8080", undefined, mockFetch);
    expect(calledUrl).toBe("http://gpu:8080/health");
  });

  it("uses custom healthPath when provided", async () => {
    let calledUrl = "";
    const mockFetch = async (url: string) => {
      calledUrl = url;
      return new Response(null, { status: 200 });
    };
    await checkHealth("http://gpu:8080", "/ping", mockFetch);
    expect(calledUrl).toBe("http://gpu:8080/ping");
  });

  it("returns false on timeout (AbortError)", async () => {
    const mockFetch = async (): Promise<Response> => {
      throw new DOMException("The operation was aborted", "AbortError");
    };
    const result = await checkHealth("http://slow-host:8000", "/health", mockFetch);
    expect(result).toBe(false);
  });

  it("returns false on 404 response", async () => {
    const mockFetch = async () => new Response(null, { status: 404 });
    const result = await checkHealth("http://localhost:8000", "/health", mockFetch);
    expect(result).toBe(false);
  });
});
