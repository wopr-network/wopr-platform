import { describe, expect, it, vi } from "vitest";
import { gatewayHealthHandler } from "./health.js";
import type { ProxyDeps } from "./proxy.js";
import type { ProviderConfig } from "./types.js";

vi.mock("../config/logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

function buildHealthDeps(overrides: Partial<ProxyDeps> = {}): ProxyDeps {
  return {
    meter: {
      emit: vi.fn(),
      flush: vi.fn(),
      pending: 0,
      close: vi.fn(),
      queryEvents: vi.fn(),
    } as unknown as ProxyDeps["meter"],
    budgetChecker: {
      check: vi.fn(),
      invalidate: vi.fn(),
      clearCache: vi.fn(),
    } as unknown as ProxyDeps["budgetChecker"],
    topUpUrl: "/dashboard/credits",
    providers: {},
    defaultMargin: 1.3,
    fetchFn: vi.fn(),
    ...overrides,
  };
}

// Dummy Hono context — gatewayHealthHandler ignores context, just needs to return Response
const dummyContext = {} as import("hono").Context;

describe("gatewayHealthHandler", () => {
  it("returns healthy with 200 when no backends are configured", async () => {
    const deps = buildHealthDeps({ providers: {} });
    const handler = gatewayHealthHandler(deps);
    const res = await handler(dummyContext);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; timestamp: number; backends: unknown[] };
    expect(body.status).toBe("healthy");
    expect(body.timestamp).toBeGreaterThan(0);
    expect(body.backends).toEqual([]);
  });

  it("reports hosted providers as healthy when API keys are configured", async () => {
    const deps = buildHealthDeps({
      providers: {
        openrouter: { apiKey: "or-key" },
        deepgram: { apiKey: "dg-key" },
        elevenlabs: { apiKey: "el-key" },
        replicate: { apiToken: "rep-token" },
        twilio: { accountSid: "AC123", authToken: "tok" },
        telnyx: { apiKey: "tel-key" },
      },
    });
    const handler = gatewayHealthHandler(deps);
    const res = await handler(dummyContext);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; backends: Array<{ name: string; status: string }> };
    expect(body.status).toBe("healthy");
    expect(body.backends).toHaveLength(6);
    for (const b of body.backends) {
      expect(b.status).toBe("healthy");
    }
  });

  it("reports hosted provider as unhealthy when API key is missing", async () => {
    const deps = buildHealthDeps({
      providers: {
        openrouter: { apiKey: "" },
      } as unknown as ProviderConfig,
    });
    const handler = gatewayHealthHandler(deps);
    const res = await handler(dummyContext);

    expect(res.status).toBe(503);
    const body = (await res.json()) as {
      status: string;
      backends: Array<{ name: string; status: string; error?: string }>;
    };
    expect(body.status).toBe("unhealthy");
    expect(body.backends[0].name).toBe("openrouter");
    expect(body.backends[0].status).toBe("unhealthy");
    expect(body.backends[0].error).toContain("API key");
  });

  it("returns degraded status (200) when some backends are unhealthy", async () => {
    const deps = buildHealthDeps({
      providers: {
        openrouter: { apiKey: "or-key" },
        deepgram: { apiKey: "" } as unknown as ProviderConfig["deepgram"],
      },
    });
    const handler = gatewayHealthHandler(deps);
    const res = await handler(dummyContext);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; backends: Array<{ name: string; status: string }> };
    expect(body.status).toBe("degraded");
    const statuses = body.backends.map((b) => b.status);
    expect(statuses).toContain("healthy");
    expect(statuses).toContain("unhealthy");
  });

  it("checks GPU backend health via fetchFn and reports healthy", async () => {
    const fetchFn = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ status: "ok" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    const deps = buildHealthDeps({
      fetchFn,
      providers: {
        gpu: {
          textGen: { baseUrl: "http://gpu:8080" },
          tts: { baseUrl: "http://gpu:8081" },
        },
      },
    });
    const handler = gatewayHealthHandler(deps);
    const res = await handler(dummyContext);

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      backends: Array<{ name: string; status: string; latency?: number }>;
    };
    expect(body.status).toBe("healthy");
    expect(body.backends).toHaveLength(2);
    expect(body.backends[0].name).toBe("gpu-text-gen");
    expect(body.backends[0].status).toBe("healthy");
    expect(body.backends[0].latency).toBeGreaterThanOrEqual(0);
    expect(body.backends[1].name).toBe("gpu-tts");

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(fetchFn).toHaveBeenCalledWith("http://gpu:8080/health", expect.objectContaining({ method: "GET" }));
    expect(fetchFn).toHaveBeenCalledWith("http://gpu:8081/health", expect.objectContaining({ method: "GET" }));
  });

  it("reports GPU backend as unhealthy when fetch returns non-200", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response("Internal Server Error", { status: 500 }));
    const deps = buildHealthDeps({
      fetchFn,
      providers: {
        gpu: { textGen: { baseUrl: "http://gpu:8080" } },
      },
    });
    const handler = gatewayHealthHandler(deps);
    const res = await handler(dummyContext);

    expect(res.status).toBe(503);
    const body = (await res.json()) as {
      status: string;
      backends: Array<{ name: string; status: string; error?: string }>;
    };
    expect(body.status).toBe("unhealthy");
    expect(body.backends[0].status).toBe("unhealthy");
    expect(body.backends[0].error).toBe("HTTP 500");
  });

  it("reports GPU backend as unhealthy when fetch throws (connection refused)", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("Connection refused"));
    const deps = buildHealthDeps({
      fetchFn,
      providers: {
        gpu: { stt: { baseUrl: "http://gpu:8082" } },
      },
    });
    const handler = gatewayHealthHandler(deps);
    const res = await handler(dummyContext);

    expect(res.status).toBe(503);
    const body = (await res.json()) as {
      status: string;
      backends: Array<{ name: string; status: string; error?: string }>;
    };
    expect(body.backends[0].status).toBe("unhealthy");
    expect(body.backends[0].error).toBe("Connection refused");
  });

  it("reports GPU backend as unhealthy when response has non-JSON content-type", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response("<html>Not Found</html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }),
    );
    const deps = buildHealthDeps({
      fetchFn,
      providers: {
        gpu: { embeddings: { baseUrl: "http://gpu:8083" } },
      },
    });
    const handler = gatewayHealthHandler(deps);
    const res = await handler(dummyContext);

    const body = (await res.json()) as { backends: Array<{ name: string; status: string; error?: string }> };
    expect(body.backends[0].status).toBe("unhealthy");
    expect(body.backends[0].error).toContain("Invalid Content-Type");
  });

  it("reports GPU backend as unhealthy when response is invalid JSON", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response("not-valid-json", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const deps = buildHealthDeps({
      fetchFn,
      providers: {
        gpu: { textGen: { baseUrl: "http://gpu:8080" } },
      },
    });
    const handler = gatewayHealthHandler(deps);
    const res = await handler(dummyContext);

    const body = (await res.json()) as { backends: Array<{ name: string; status: string; error?: string }> };
    expect(body.backends[0].status).toBe("unhealthy");
    expect(body.backends[0].error).toBe("Invalid JSON response");
  });

  it("returns degraded when GPU is down but hosted providers are up", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("timeout"));
    const deps = buildHealthDeps({
      fetchFn,
      providers: {
        openrouter: { apiKey: "or-key" },
        gpu: { textGen: { baseUrl: "http://gpu:8080" } },
      },
    });
    const handler = gatewayHealthHandler(deps);
    const res = await handler(dummyContext);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; backends: Array<{ name: string; status: string }> };
    expect(body.status).toBe("degraded");
  });

  it("reports twilio as unhealthy when only accountSid is set", async () => {
    const deps = buildHealthDeps({
      providers: {
        twilio: { accountSid: "AC123", authToken: "" } as unknown as ProviderConfig["twilio"],
      },
    });
    const handler = gatewayHealthHandler(deps);
    const res = await handler(dummyContext);

    const body = (await res.json()) as { backends: Array<{ name: string; status: string; error?: string }> };
    expect(body.backends[0].name).toBe("twilio");
    expect(body.backends[0].status).toBe("unhealthy");
  });
});
