import { describe, expect, it, vi } from "vitest";
import { withMargin } from "../monetization/adapters/types.js";
import { Credit } from "../monetization/credit.js";
import type { ProxyDeps } from "./proxy.js";
import { DEFAULT_TOKEN_RATES } from "./rate-lookup.js";
import { proxySSEStream } from "./streaming.js";
import type { GatewayTenant } from "./types.js";

const mockTenant: GatewayTenant = {
  id: "tenant-123",
  spendLimits: { maxSpendPerHour: null, maxSpendPerMonth: null },
};

function makeDeps(overrides?: Partial<ProxyDeps>): ProxyDeps {
  return {
    meter: {
      emit: vi.fn(),
      flush: vi.fn().mockResolvedValue(0),
      pending: 0,
      close: vi.fn(),
      queryEvents: vi.fn(),
    } as unknown as ProxyDeps["meter"],
    budgetChecker: { check: vi.fn() } as unknown as ProxyDeps["budgetChecker"],
    topUpUrl: "/credits",
    defaultMargin: 1.3,
    providers: {},
    fetchFn: vi.fn(),
    ...overrides,
  };
}

function fakeSSEResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

/** Consume the response body and wait for pipeTo flush to settle. */
async function drainAndSettle(res: Response): Promise<string> {
  const text = await res.text();
  // Allow pipeTo microtask and flush() to complete
  await new Promise((r) => setTimeout(r, 100));
  return text;
}

describe("proxySSEStream", () => {
  describe("cost-header metering", () => {
    it("emits meter event with cost from costHeader when provided", async () => {
      const deps = makeDeps();
      const upstream = fakeSSEResponse(['data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n', "data: [DONE]\n\n"]);

      const res = proxySSEStream(upstream, {
        tenant: mockTenant,
        deps,
        capability: "chat-completions",
        provider: "openrouter",
        costHeader: "0.005",
      });

      await drainAndSettle(res);

      const emit = deps.meter.emit as ReturnType<typeof vi.fn>;
      expect(emit).toHaveBeenCalledOnce();

      const event = emit.mock.calls[0][0];
      const expectedCost = Credit.fromDollars(0.005);
      const expectedCharge = withMargin(expectedCost, 1.3);
      expect(event.tenant).toBe("tenant-123");
      expect(event.cost.toRaw()).toBe(expectedCost.toRaw());
      expect(event.charge.toRaw()).toBe(expectedCharge.toRaw());
      expect(event.capability).toBe("chat-completions");
      expect(event.provider).toBe("openrouter");
      expect(typeof event.timestamp).toBe("number");
    });

    it("costHeader takes precedence over usage-based calculation", async () => {
      const deps = makeDeps();
      const upstream = fakeSSEResponse([
        'data: {"choices":[{"delta":{"content":"Hi"}}],"usage":{"prompt_tokens":100,"completion_tokens":50}}\n\n',
        "data: [DONE]\n\n",
      ]);

      const res = proxySSEStream(upstream, {
        tenant: mockTenant,
        deps,
        capability: "chat-completions",
        provider: "openrouter",
        costHeader: "0.01",
      });

      await drainAndSettle(res);

      const emit = deps.meter.emit as ReturnType<typeof vi.fn>;
      expect(emit).toHaveBeenCalledOnce();

      const event = emit.mock.calls[0][0];
      // Should use costHeader ($0.01), NOT token-based calculation
      expect(event.cost.toRaw()).toBe(Credit.fromDollars(0.01).toRaw());
    });
  });

  describe("token-based fallback metering (no cost header)", () => {
    it("calculates cost from usage tokens using DEFAULT_TOKEN_RATES when no rateLookupFn", async () => {
      const deps = makeDeps();
      const upstream = fakeSSEResponse([
        'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":" world"}}],"usage":{"prompt_tokens":100,"completion_tokens":200}}\n\n',
        "data: [DONE]\n\n",
      ]);

      const res = proxySSEStream(upstream, {
        tenant: mockTenant,
        deps,
        capability: "chat-completions",
        provider: "openrouter",
        costHeader: null,
      });

      await drainAndSettle(res);

      const emit = deps.meter.emit as ReturnType<typeof vi.fn>;
      expect(emit).toHaveBeenCalledOnce();

      const event = emit.mock.calls[0][0];
      // DEFAULT_TOKEN_RATES: input=0.001/1K, output=0.002/1K
      // cost = (100 * 0.001 + 200 * 0.002) / 1000 = 0.0005
      const expectedCost = Credit.fromDollars(
        (100 * DEFAULT_TOKEN_RATES.inputRatePer1K + 200 * DEFAULT_TOKEN_RATES.outputRatePer1K) / 1000,
      );
      expect(event.cost.toRaw()).toBe(expectedCost.toRaw());
    });

    it("uses rateLookupFn when provided for token cost calculation", async () => {
      const rateLookupFn = vi.fn().mockResolvedValue({
        price_usd: 0.01,
        capability: "chat-completions",
        model: "gpt-4",
        unit: "1K-input-tokens",
      });

      const deps = makeDeps();
      const upstream = fakeSSEResponse([
        'data: {"usage":{"prompt_tokens":500,"completion_tokens":100}}\n\n',
        "data: [DONE]\n\n",
      ]);

      const res = proxySSEStream(upstream, {
        tenant: mockTenant,
        deps,
        capability: "chat-completions",
        provider: "openrouter",
        costHeader: null,
        model: "gpt-4",
        rateLookupFn,
      });

      await drainAndSettle(res);

      const emit = deps.meter.emit as ReturnType<typeof vi.fn>;
      expect(emit).toHaveBeenCalledOnce();
      // rateLookupFn is passed to resolveTokenRates which does its own lookups
      expect(rateLookupFn).toHaveBeenCalled();
    });

    it("emits zero-dollar cost when no costHeader and no usage in stream", async () => {
      const deps = makeDeps();
      const upstream = fakeSSEResponse(['data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n', "data: [DONE]\n\n"]);

      const res = proxySSEStream(upstream, {
        tenant: mockTenant,
        deps,
        capability: "chat-completions",
        provider: "openrouter",
        costHeader: null,
      });

      await drainAndSettle(res);

      const emit = deps.meter.emit as ReturnType<typeof vi.fn>;
      expect(emit).toHaveBeenCalledOnce();

      const event = emit.mock.calls[0][0];
      expect(event.cost.toRaw()).toBe(Credit.fromDollars(0).toRaw());
    });
  });

  describe("margin application", () => {
    it("applies default 1.3x margin to cost", async () => {
      const deps = makeDeps({ defaultMargin: 1.3 });
      const upstream = fakeSSEResponse(['data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n', "data: [DONE]\n\n"]);

      const res = proxySSEStream(upstream, {
        tenant: mockTenant,
        deps,
        capability: "chat-completions",
        provider: "openrouter",
        costHeader: "1.00",
      });

      await drainAndSettle(res);

      const emit = deps.meter.emit as ReturnType<typeof vi.fn>;
      const event = emit.mock.calls[0][0];
      const expectedCost = Credit.fromDollars(1.0);
      const expectedCharge = withMargin(expectedCost, 1.3);
      expect(event.charge.toRaw()).toBe(expectedCharge.toRaw());
    });

    it("applies custom margin (e.g., 20% as percentage)", async () => {
      const deps = makeDeps({ defaultMargin: 20 });
      const upstream = fakeSSEResponse(["data: [DONE]\n\n"]);

      const res = proxySSEStream(upstream, {
        tenant: mockTenant,
        deps,
        capability: "chat-completions",
        provider: "openrouter",
        costHeader: "0.50",
      });

      await drainAndSettle(res);

      const emit = deps.meter.emit as ReturnType<typeof vi.fn>;
      const event = emit.mock.calls[0][0];
      const expectedCost = Credit.fromDollars(0.5);
      // 20 >= 3, treated as percentage: multiplier = 1 + 20/100 = 1.2
      const expectedCharge = withMargin(expectedCost, 20);
      expect(event.charge.toRaw()).toBe(expectedCharge.toRaw());
    });

    it("applies 2x margin multiplier", async () => {
      const deps = makeDeps({ defaultMargin: 2.0 });
      const upstream = fakeSSEResponse(["data: [DONE]\n\n"]);

      const res = proxySSEStream(upstream, {
        tenant: mockTenant,
        deps,
        capability: "chat-completions",
        provider: "openrouter",
        costHeader: "0.10",
      });

      await drainAndSettle(res);

      const emit = deps.meter.emit as ReturnType<typeof vi.fn>;
      const event = emit.mock.calls[0][0];
      const expectedCost = Credit.fromDollars(0.1);
      const expectedCharge = withMargin(expectedCost, 2.0);
      expect(event.charge.toRaw()).toBe(expectedCharge.toRaw());
    });
  });

  describe("SSE event forwarding", () => {
    it("returns Response with correct SSE headers", () => {
      const deps = makeDeps();
      const upstream = fakeSSEResponse(["data: [DONE]\n\n"]);

      const res = proxySSEStream(upstream, {
        tenant: mockTenant,
        deps,
        capability: "chat-completions",
        provider: "openrouter",
        costHeader: null,
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("text/event-stream");
      expect(res.headers.get("Cache-Control")).toBe("no-cache");
      expect(res.headers.get("Connection")).toBe("keep-alive");
    });

    it("forwards all SSE chunks unchanged to the client", async () => {
      const deps = makeDeps();
      const chunks = [
        'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
        "data: [DONE]\n\n",
      ];
      const upstream = fakeSSEResponse(chunks);

      const res = proxySSEStream(upstream, {
        tenant: mockTenant,
        deps,
        capability: "chat-completions",
        provider: "openrouter",
        costHeader: "0.001",
      });

      const body = await drainAndSettle(res);
      // All chunks should appear in order in the response body
      expect(body).toContain('{"choices":[{"delta":{"content":"Hello"}}]}');
      expect(body).toContain('{"choices":[{"delta":{"content":" world"}}]}');
      expect(body).toContain("[DONE]");
    });
  });

  describe("edge cases", () => {
    it("handles malformed JSON in SSE chunks gracefully (still emits meter)", async () => {
      const deps = makeDeps();
      const upstream = fakeSSEResponse(["data: {not valid json}\n\n", "data: [DONE]\n\n"]);

      const res = proxySSEStream(upstream, {
        tenant: mockTenant,
        deps,
        capability: "chat-completions",
        provider: "openrouter",
        costHeader: "0.002",
      });

      await drainAndSettle(res);

      const emit = deps.meter.emit as ReturnType<typeof vi.fn>;
      expect(emit).toHaveBeenCalledOnce();
      // Cost should still come from costHeader despite malformed chunk
      expect(emit.mock.calls[0][0].cost.toRaw()).toBe(Credit.fromDollars(0.002).toRaw());
    });

    it("handles upstream Response with null body", async () => {
      const deps = makeDeps();
      // Construct a response with no body
      const upstream = new Response(null, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });

      const res = proxySSEStream(upstream, {
        tenant: mockTenant,
        deps,
        capability: "chat-completions",
        provider: "openrouter",
        costHeader: "0.001",
      });

      // Response should still be valid — just no data flows
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    });

    it("handles empty stream (no chunks before close)", async () => {
      const deps = makeDeps();
      const upstream = fakeSSEResponse([]);

      const res = proxySSEStream(upstream, {
        tenant: mockTenant,
        deps,
        capability: "chat-completions",
        provider: "openrouter",
        costHeader: null,
      });

      await drainAndSettle(res);

      const emit = deps.meter.emit as ReturnType<typeof vi.fn>;
      expect(emit).toHaveBeenCalledOnce();
      // Zero cost — no costHeader, no usage
      expect(emit.mock.calls[0][0].cost.toRaw()).toBe(0);
    });

    it("handles SSE lines that are not data lines (comments, events)", async () => {
      const deps = makeDeps();
      const upstream = fakeSSEResponse([
        ": this is a comment\n\n",
        "event: ping\ndata: {}\n\n",
        'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
        "data: [DONE]\n\n",
      ]);

      const res = proxySSEStream(upstream, {
        tenant: mockTenant,
        deps,
        capability: "chat-completions",
        provider: "openrouter",
        costHeader: "0.003",
      });

      await drainAndSettle(res);

      const emit = deps.meter.emit as ReturnType<typeof vi.fn>;
      expect(emit).toHaveBeenCalledOnce();
      expect(emit.mock.calls[0][0].cost.toRaw()).toBe(Credit.fromDollars(0.003).toRaw());
    });

    it("usage with only prompt_tokens (no completion_tokens) defaults completion to 0", async () => {
      const deps = makeDeps();
      const upstream = fakeSSEResponse(['data: {"usage":{"prompt_tokens":500}}\n\n', "data: [DONE]\n\n"]);

      const res = proxySSEStream(upstream, {
        tenant: mockTenant,
        deps,
        capability: "chat-completions",
        provider: "openrouter",
        costHeader: null,
      });

      await drainAndSettle(res);

      const emit = deps.meter.emit as ReturnType<typeof vi.fn>;
      const event = emit.mock.calls[0][0];
      // cost = (500 * 0.001 + 0 * 0.002) / 1000 = 0.0005
      const expectedCost = Credit.fromDollars((500 * DEFAULT_TOKEN_RATES.inputRatePer1K) / 1000);
      expect(event.cost.toRaw()).toBe(expectedCost.toRaw());
    });
  });
});
