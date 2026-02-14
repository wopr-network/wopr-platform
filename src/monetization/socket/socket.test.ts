import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AdapterCapability, AdapterResult, ProviderAdapter, TranscriptionOutput } from "../adapters/types.js";
import { BudgetChecker } from "../budget/budget-checker.js";
import type { MeterEmitter } from "../metering/emitter.js";
import { initMeterSchema } from "../metering/schema.js";
import type { MeterEvent } from "../metering/types.js";
import { DEFAULT_TIERS, TierStore } from "../quotas/tier-definitions.js";
import { AdapterSocket, type SocketConfig } from "./socket.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stubMeter(): MeterEmitter & { events: MeterEvent[] } {
  const events: MeterEvent[] = [];
  return {
    events,
    emit(event: MeterEvent) {
      events.push(event);
    },
  } as unknown as MeterEmitter & { events: MeterEvent[] };
}

function stubAdapter(overrides: Partial<ProviderAdapter> = {}): ProviderAdapter {
  return {
    name: "test-provider",
    capabilities: ["transcription"] as ReadonlyArray<AdapterCapability>,
    async transcribe() {
      return {
        result: { text: "hello", detectedLanguage: "en", durationSeconds: 10 },
        cost: 0.01,
      } satisfies AdapterResult<TranscriptionOutput>;
    },
    ...overrides,
  };
}

function createSocket(meter: MeterEmitter, defaultMargin?: number): AdapterSocket {
  const config: SocketConfig = { meter, defaultMargin };
  return new AdapterSocket(config);
}

// ---------------------------------------------------------------------------
// Registration & capability routing
// ---------------------------------------------------------------------------

describe("AdapterSocket", () => {
  describe("register / capabilities", () => {
    it("returns empty capabilities when no adapters are registered", () => {
      const socket = createSocket(stubMeter());
      expect(socket.capabilities()).toEqual([]);
    });

    it("lists capabilities from a single adapter", () => {
      const socket = createSocket(stubMeter());
      socket.register(stubAdapter());
      expect(socket.capabilities()).toEqual(["transcription"]);
    });

    it("deduplicates capabilities across adapters", () => {
      const socket = createSocket(stubMeter());
      socket.register(stubAdapter({ name: "a" }));
      socket.register(stubAdapter({ name: "b" }));
      expect(socket.capabilities()).toEqual(["transcription"]);
    });

    it("aggregates distinct capabilities from multiple adapters", () => {
      const socket = createSocket(stubMeter());
      socket.register(stubAdapter({ name: "a", capabilities: ["transcription"] }));
      socket.register(stubAdapter({ name: "b", capabilities: ["image-generation"] }));
      expect(socket.capabilities()).toContain("transcription");
      expect(socket.capabilities()).toContain("image-generation");
      expect(socket.capabilities()).toHaveLength(2);
    });

    it("overwrites adapter when re-registering same name", () => {
      const socket = createSocket(stubMeter());
      socket.register(stubAdapter({ capabilities: ["transcription"] }));
      socket.register(stubAdapter({ capabilities: ["image-generation"] }));
      // Only the second registration survives
      expect(socket.capabilities()).toEqual(["image-generation"]);
    });
  });

  // ---------------------------------------------------------------------------
  // execute — adapter selection
  // ---------------------------------------------------------------------------

  describe("execute — adapter selection", () => {
    it("selects the first adapter supporting the capability", async () => {
      const meter = stubMeter();
      const socket = createSocket(meter);
      socket.register(stubAdapter());

      const result = await socket.execute<TranscriptionOutput>({
        tenantId: "t-1",
        capability: "transcription",
        input: { audioUrl: "https://example.com/audio.mp3" },
      });

      expect(result.text).toBe("hello");
    });

    it("uses a specifically requested adapter", async () => {
      const meter = stubMeter();
      const socket = createSocket(meter);
      socket.register(stubAdapter({ name: "a" }));
      socket.register(
        stubAdapter({
          name: "b",
          async transcribe() {
            return { result: { text: "from-b", detectedLanguage: "en", durationSeconds: 5 }, cost: 0.02 };
          },
        }),
      );

      const result = await socket.execute<TranscriptionOutput>({
        tenantId: "t-1",
        capability: "transcription",
        input: { audioUrl: "https://example.com/audio.mp3" },
        adapter: "b",
      });

      expect(result.text).toBe("from-b");
    });

    it("throws when requested adapter is not registered", async () => {
      const socket = createSocket(stubMeter());
      await expect(
        socket.execute({
          tenantId: "t-1",
          capability: "transcription",
          input: {},
          adapter: "missing",
        }),
      ).rejects.toThrow('Adapter "missing" is not registered');
    });

    it("throws when requested adapter does not support the capability", async () => {
      const socket = createSocket(stubMeter());
      socket.register(stubAdapter({ name: "a", capabilities: ["transcription"] }));
      await expect(
        socket.execute({
          tenantId: "t-1",
          capability: "image-generation",
          input: {},
          adapter: "a",
        }),
      ).rejects.toThrow('Adapter "a" does not support capability "image-generation"');
    });

    it("throws when no adapter supports the capability", async () => {
      const socket = createSocket(stubMeter());
      socket.register(stubAdapter({ capabilities: ["transcription"] }));
      await expect(
        socket.execute({
          tenantId: "t-1",
          capability: "image-generation",
          input: {},
        }),
      ).rejects.toThrow('No adapter registered for capability "image-generation"');
    });
  });

  // ---------------------------------------------------------------------------
  // execute — metering
  // ---------------------------------------------------------------------------

  describe("execute — metering", () => {
    it("emits a meter event after successful call", async () => {
      const meter = stubMeter();
      const socket = createSocket(meter);
      socket.register(stubAdapter());

      await socket.execute({
        tenantId: "t-1",
        capability: "transcription",
        input: { audioUrl: "https://example.com/audio.mp3" },
      });

      expect(meter.events).toHaveLength(1);
      const event = meter.events[0];
      expect(event.tenant).toBe("t-1");
      expect(event.cost).toBe(0.01);
      expect(event.capability).toBe("transcription");
      expect(event.provider).toBe("test-provider");
      expect(event.timestamp).toBeGreaterThan(0);
    });

    it("applies default margin when adapter does not supply charge", async () => {
      const meter = stubMeter();
      const socket = createSocket(meter, 1.5); // 50% margin
      socket.register(
        stubAdapter({
          async transcribe() {
            return { result: { text: "hi", detectedLanguage: "en", durationSeconds: 1 }, cost: 0.1 };
          },
        }),
      );

      await socket.execute({
        tenantId: "t-1",
        capability: "transcription",
        input: { audioUrl: "https://example.com/audio.mp3" },
      });

      // 0.1 * 1.5 = 0.15
      expect(meter.events[0].charge).toBe(0.15);
    });

    it("uses adapter-supplied charge when present", async () => {
      const meter = stubMeter();
      const socket = createSocket(meter);
      socket.register(
        stubAdapter({
          async transcribe() {
            return {
              result: { text: "hi", detectedLanguage: "en", durationSeconds: 1 },
              cost: 0.1,
              charge: 0.25,
            };
          },
        }),
      );

      await socket.execute({
        tenantId: "t-1",
        capability: "transcription",
        input: { audioUrl: "https://example.com/audio.mp3" },
      });

      expect(meter.events[0].charge).toBe(0.25);
    });

    it("respects per-request margin override", async () => {
      const meter = stubMeter();
      const socket = createSocket(meter, 1.3);
      socket.register(
        stubAdapter({
          async transcribe() {
            return { result: { text: "hi", detectedLanguage: "en", durationSeconds: 1 }, cost: 0.1 };
          },
        }),
      );

      await socket.execute({
        tenantId: "t-1",
        capability: "transcription",
        input: { audioUrl: "https://example.com/audio.mp3" },
        margin: 2.0,
      });

      // 0.1 * 2.0 = 0.2
      expect(meter.events[0].charge).toBe(0.2);
    });

    it("includes sessionId when provided", async () => {
      const meter = stubMeter();
      const socket = createSocket(meter);
      socket.register(stubAdapter());

      await socket.execute({
        tenantId: "t-1",
        capability: "transcription",
        input: { audioUrl: "https://example.com/audio.mp3" },
        sessionId: "sess-42",
      });

      expect(meter.events[0].sessionId).toBe("sess-42");
    });

    it("omits sessionId when not provided", async () => {
      const meter = stubMeter();
      const socket = createSocket(meter);
      socket.register(stubAdapter());

      await socket.execute({
        tenantId: "t-1",
        capability: "transcription",
        input: { audioUrl: "https://example.com/audio.mp3" },
      });

      expect(meter.events[0].sessionId).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // execute — error handling
  // ---------------------------------------------------------------------------

  describe("execute — error handling", () => {
    it("does not emit meter event when adapter throws", async () => {
      const meter = stubMeter();
      const socket = createSocket(meter);
      socket.register(
        stubAdapter({
          async transcribe() {
            throw new Error("provider unavailable");
          },
        }),
      );

      await expect(
        socket.execute({
          tenantId: "t-1",
          capability: "transcription",
          input: { audioUrl: "https://example.com/audio.mp3" },
        }),
      ).rejects.toThrow("provider unavailable");

      expect(meter.events).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // execute — BYOK bypass
  // ---------------------------------------------------------------------------

  describe("execute — BYOK bypass", () => {
    it("emits cost: 0, charge: 0 when byok is true", async () => {
      const meter = stubMeter();
      const socket = createSocket(meter);
      socket.register(stubAdapter());

      await socket.execute({
        tenantId: "t-1",
        capability: "transcription",
        input: { audioUrl: "https://example.com/audio.mp3" },
        byok: true,
      });

      expect(meter.events).toHaveLength(1);
      expect(meter.events[0].cost).toBe(0);
      expect(meter.events[0].charge).toBe(0);
    });

    it("still returns the adapter result when byok is true", async () => {
      const meter = stubMeter();
      const socket = createSocket(meter);
      socket.register(stubAdapter());

      const result = await socket.execute<TranscriptionOutput>({
        tenantId: "t-1",
        capability: "transcription",
        input: { audioUrl: "https://example.com/audio.mp3" },
        byok: true,
      });

      expect(result.text).toBe("hello");
    });

    it("emits normal cost when byok is false", async () => {
      const meter = stubMeter();
      const socket = createSocket(meter);
      socket.register(stubAdapter());

      await socket.execute({
        tenantId: "t-1",
        capability: "transcription",
        input: { audioUrl: "https://example.com/audio.mp3" },
        byok: false,
      });

      expect(meter.events[0].cost).toBe(0.01);
    });
  });

  // ---------------------------------------------------------------------------
  // execute — budget check
  // ---------------------------------------------------------------------------

  describe("execute — budget check", () => {
    let db: Database.Database;
    let budgetChecker: BudgetChecker;

    beforeEach(() => {
      db = new Database(":memory:");
      initMeterSchema(db);
      const tierStore = new TierStore(db);
      tierStore.seed(DEFAULT_TIERS);
      budgetChecker = new BudgetChecker(db, { cacheTtlMs: 1000 });
    });

    afterEach(() => {
      db.close();
    });

    it("allows requests when budget is under limit", async () => {
      const meter = stubMeter();
      const socket = new AdapterSocket({ meter, budgetChecker });
      socket.register(stubAdapter());

      const result = await socket.execute<TranscriptionOutput>({
        tenantId: "t-1",
        capability: "transcription",
        input: { audioUrl: "https://example.com/audio.mp3" },
        tier: "free",
      });

      expect(result.text).toBe("hello");
      expect(meter.events).toHaveLength(1);
    });

    it("blocks requests when hourly budget is exceeded", async () => {
      // Add events to exceed hourly limit ($0.50)
      const now = Date.now();
      db.prepare(
        "INSERT INTO meter_events (id, tenant, cost, charge, capability, provider, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run("evt-1", "t-1", 0.3, 0.6, "chat", "replicate", now);

      const meter = stubMeter();
      const socket = new AdapterSocket({ meter, budgetChecker });
      socket.register(stubAdapter());

      await expect(
        socket.execute({
          tenantId: "t-1",
          capability: "transcription",
          input: { audioUrl: "https://example.com/audio.mp3" },
          tier: "free",
        }),
      ).rejects.toThrow("Hourly spending limit exceeded");

      expect(meter.events).toHaveLength(0); // No meter event emitted
    });

    it("blocks requests when monthly budget is exceeded", async () => {
      // Add old events to exceed monthly limit but not hourly ($5.00)
      const now = Date.now();
      const twoHoursAgo = now - 2 * 60 * 60 * 1000;
      db.prepare(
        "INSERT INTO meter_events (id, tenant, cost, charge, capability, provider, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run("evt-1", "t-monthly", 2.5, 5.0, "chat", "replicate", twoHoursAgo);

      const meter = stubMeter();
      const socket = new AdapterSocket({ meter, budgetChecker });
      socket.register(stubAdapter());

      await expect(
        socket.execute({
          tenantId: "t-monthly",
          capability: "transcription",
          input: { audioUrl: "https://example.com/audio.mp3" },
          tier: "free",
        }),
      ).rejects.toThrow("Monthly spending limit exceeded");

      expect(meter.events).toHaveLength(0);
    });

    it("skips budget check when tier is not provided", async () => {
      // Even though budget is exceeded, no tier means no check
      const now = Date.now();
      db.prepare(
        "INSERT INTO meter_events (id, tenant, cost, charge, capability, provider, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run("evt-1", "t-1", 3.0, 6.0, "chat", "replicate", now);

      const meter = stubMeter();
      const socket = new AdapterSocket({ meter, budgetChecker });
      socket.register(stubAdapter());

      const result = await socket.execute<TranscriptionOutput>({
        tenantId: "t-1",
        capability: "transcription",
        input: { audioUrl: "https://example.com/audio.mp3" },
        // No tier provided
      });

      expect(result.text).toBe("hello");
      expect(meter.events).toHaveLength(1);
    });

    it("skips budget check when byok is true", async () => {
      // BYOK users bypass budget checks
      const now = Date.now();
      db.prepare(
        "INSERT INTO meter_events (id, tenant, cost, charge, capability, provider, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run("evt-1", "t-1", 3.0, 6.0, "chat", "replicate", now);

      const meter = stubMeter();
      const socket = new AdapterSocket({ meter, budgetChecker });
      socket.register(stubAdapter());

      const result = await socket.execute<TranscriptionOutput>({
        tenantId: "t-1",
        capability: "transcription",
        input: { audioUrl: "https://example.com/audio.mp3" },
        tier: "free",
        byok: true,
      });

      expect(result.text).toBe("hello");
      expect(meter.events).toHaveLength(1);
    });

    it("works when budgetChecker is not configured", async () => {
      const meter = stubMeter();
      const socket = new AdapterSocket({ meter }); // No budgetChecker
      socket.register(stubAdapter());

      const result = await socket.execute<TranscriptionOutput>({
        tenantId: "t-1",
        capability: "transcription",
        input: { audioUrl: "https://example.com/audio.mp3" },
        tier: "free",
      });

      expect(result.text).toBe("hello");
    });

    it("includes httpStatus in error when budget exceeded", async () => {
      const now = Date.now();
      db.prepare(
        "INSERT INTO meter_events (id, tenant, cost, charge, capability, provider, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run("evt-1", "t-1", 0.3, 0.6, "chat", "replicate", now);

      const meter = stubMeter();
      const socket = new AdapterSocket({ meter, budgetChecker });
      socket.register(stubAdapter());

      try {
        await socket.execute({
          tenantId: "t-1",
          capability: "transcription",
          input: { audioUrl: "https://example.com/audio.mp3" },
          tier: "free",
        });
        expect.fail("Should have thrown");
      } catch (err) {
        const error = err as Error & { httpStatus?: number; budgetCheck?: unknown };
        expect(error.httpStatus).toBe(429);
        expect(error.budgetCheck).toBeDefined();
      }
    });
  });
});
