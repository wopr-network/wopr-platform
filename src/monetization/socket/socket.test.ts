import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DrizzleDb } from "../../db/index.js";
import { meterEvents } from "../../db/schema/meter-events.js";
import { createTestDb } from "../../test/db.js";
import type {
  AdapterCapability,
  AdapterResult,
  EmbeddingsOutput,
  ProviderAdapter,
  TranscriptionOutput,
  TTSOutput,
} from "../adapters/types.js";
import { BudgetChecker, type SpendLimits } from "../budget/budget-checker.js";
import type { MeterEmitter } from "../metering/emitter.js";
import type { MeterEvent } from "../metering/types.js";
import { AdapterSocket, type SocketConfig } from "./socket.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Free tier limits (matching old DEFAULT_TIERS["free"]) */
const FREE_LIMITS: SpendLimits = {
  maxSpendPerHour: 0.5,
  maxSpendPerMonth: 5,
  label: "free",
};

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
  // execute -- adapter selection
  // ---------------------------------------------------------------------------

  describe("execute -- adapter selection", () => {
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
  // execute -- tier-aware routing (WOP-497)
  // ---------------------------------------------------------------------------

  describe("execute -- tier-aware routing", () => {
    it("prefers self-hosted adapter when pricingTier is standard", async () => {
      const meter = stubMeter();
      const socket = createSocket(meter);

      // Register premium (third-party) adapter first
      socket.register(
        stubAdapter({
          name: "elevenlabs",
          capabilities: ["tts"],
          selfHosted: false,
          async synthesizeSpeech() {
            return {
              result: { audioUrl: "premium-audio", durationSeconds: 2, format: "mp3", characterCount: 10 },
              cost: 0.015,
            } satisfies AdapterResult<TTSOutput>;
          },
        }),
      );

      // Register self-hosted adapter second
      socket.register(
        stubAdapter({
          name: "chatterbox-tts",
          capabilities: ["tts"],
          selfHosted: true,
          async synthesizeSpeech() {
            return {
              result: { audioUrl: "self-hosted-audio", durationSeconds: 2, format: "wav", characterCount: 10 },
              cost: 0.002,
            } satisfies AdapterResult<TTSOutput>;
          },
        }),
      );

      const result = await socket.execute<TTSOutput>({
        tenantId: "t-1",
        capability: "tts",
        input: { text: "hello" },
        pricingTier: "standard",
      });

      expect(result.audioUrl).toBe("self-hosted-audio");
      expect(meter.events[0].provider).toBe("chatterbox-tts");
      expect(meter.events[0].cost).toBe(0.002);
    });

    it("prefers third-party adapter when pricingTier is premium", async () => {
      const meter = stubMeter();
      const socket = createSocket(meter);

      // Register self-hosted adapter first
      socket.register(
        stubAdapter({
          name: "chatterbox-tts",
          capabilities: ["tts"],
          selfHosted: true,
          async synthesizeSpeech() {
            return {
              result: { audioUrl: "self-hosted-audio", durationSeconds: 2, format: "wav", characterCount: 10 },
              cost: 0.002,
            } satisfies AdapterResult<TTSOutput>;
          },
        }),
      );

      // Register premium (third-party) adapter second
      socket.register(
        stubAdapter({
          name: "elevenlabs",
          capabilities: ["tts"],
          selfHosted: false,
          async synthesizeSpeech() {
            return {
              result: { audioUrl: "premium-audio", durationSeconds: 2, format: "mp3", characterCount: 10 },
              cost: 0.015,
            } satisfies AdapterResult<TTSOutput>;
          },
        }),
      );

      const result = await socket.execute<TTSOutput>({
        tenantId: "t-1",
        capability: "tts",
        input: { text: "hello" },
        pricingTier: "premium",
      });

      expect(result.audioUrl).toBe("premium-audio");
      expect(meter.events[0].provider).toBe("elevenlabs");
      expect(meter.events[0].cost).toBe(0.015);
    });

    it("falls back to any adapter when preferred tier unavailable", async () => {
      const meter = stubMeter();
      const socket = createSocket(meter);

      // Only register a premium adapter
      socket.register(
        stubAdapter({
          name: "elevenlabs",
          capabilities: ["tts"],
          selfHosted: false,
          async synthesizeSpeech() {
            return {
              result: { audioUrl: "premium-audio", durationSeconds: 2, format: "mp3", characterCount: 10 },
              cost: 0.015,
            } satisfies AdapterResult<TTSOutput>;
          },
        }),
      );

      // Request standard tier, but only premium is available
      const result = await socket.execute<TTSOutput>({
        tenantId: "t-1",
        capability: "tts",
        input: { text: "hello" },
        pricingTier: "standard",
      });

      expect(result.audioUrl).toBe("premium-audio");
      expect(meter.events[0].provider).toBe("elevenlabs");
    });

    it("uses first adapter with capability when no pricingTier specified", async () => {
      const meter = stubMeter();
      const socket = createSocket(meter);

      socket.register(
        stubAdapter({
          name: "adapter-a",
          capabilities: ["tts"],
          async synthesizeSpeech() {
            return {
              result: { audioUrl: "first-audio", durationSeconds: 2, format: "mp3", characterCount: 10 },
              cost: 0.01,
            } satisfies AdapterResult<TTSOutput>;
          },
        }),
      );

      socket.register(
        stubAdapter({
          name: "adapter-b",
          capabilities: ["tts"],
          async synthesizeSpeech() {
            return {
              result: { audioUrl: "second-audio", durationSeconds: 2, format: "mp3", characterCount: 10 },
              cost: 0.02,
            } satisfies AdapterResult<TTSOutput>;
          },
        }),
      );

      const result = await socket.execute<TTSOutput>({
        tenantId: "t-1",
        capability: "tts",
        input: { text: "hello" },
        // No pricingTier specified
      });

      expect(result.audioUrl).toBe("first-audio");
      expect(meter.events[0].provider).toBe("adapter-a");
    });

    it("adapter parameter takes priority over pricingTier", async () => {
      const meter = stubMeter();
      const socket = createSocket(meter);

      socket.register(
        stubAdapter({
          name: "chatterbox-tts",
          capabilities: ["tts"],
          selfHosted: true,
          async synthesizeSpeech() {
            return {
              result: { audioUrl: "self-hosted-audio", durationSeconds: 2, format: "wav", characterCount: 10 },
              cost: 0.002,
            } satisfies AdapterResult<TTSOutput>;
          },
        }),
      );

      socket.register(
        stubAdapter({
          name: "elevenlabs",
          capabilities: ["tts"],
          selfHosted: false,
          async synthesizeSpeech() {
            return {
              result: { audioUrl: "premium-audio", durationSeconds: 2, format: "mp3", characterCount: 10 },
              cost: 0.015,
            } satisfies AdapterResult<TTSOutput>;
          },
        }),
      );

      // Request standard tier but explicitly specify elevenlabs
      const result = await socket.execute<TTSOutput>({
        tenantId: "t-1",
        capability: "tts",
        input: { text: "hello" },
        pricingTier: "standard",
        adapter: "elevenlabs", // This should win
      });

      expect(result.audioUrl).toBe("premium-audio");
      expect(meter.events[0].provider).toBe("elevenlabs");
    });

    it("distinguishes self-hosted from third-party in meter events", async () => {
      const meter = stubMeter();
      const socket = createSocket(meter);

      socket.register(
        stubAdapter({
          name: "chatterbox-tts",
          capabilities: ["tts"],
          selfHosted: true,
          async synthesizeSpeech() {
            return {
              result: { audioUrl: "self-hosted-audio", durationSeconds: 2, format: "wav", characterCount: 10 },
              cost: 0.002,
            } satisfies AdapterResult<TTSOutput>;
          },
        }),
      );

      socket.register(
        stubAdapter({
          name: "elevenlabs",
          capabilities: ["tts"],
          selfHosted: false,
          async synthesizeSpeech() {
            return {
              result: { audioUrl: "premium-audio", durationSeconds: 2, format: "mp3", characterCount: 10 },
              cost: 0.015,
            } satisfies AdapterResult<TTSOutput>;
          },
        }),
      );

      // Call self-hosted
      await socket.execute<TTSOutput>({
        tenantId: "t-1",
        capability: "tts",
        input: { text: "hello" },
        pricingTier: "standard",
      });

      // Call third-party
      await socket.execute<TTSOutput>({
        tenantId: "t-1",
        capability: "tts",
        input: { text: "hello" },
        pricingTier: "premium",
      });

      expect(meter.events).toHaveLength(2);
      expect(meter.events[0].provider).toBe("chatterbox-tts");
      expect(meter.events[0].cost).toBe(0.002);
      expect(meter.events[1].provider).toBe("elevenlabs");
      expect(meter.events[1].cost).toBe(0.015);
    });
  });

  // ---------------------------------------------------------------------------
  // execute -- metering
  // ---------------------------------------------------------------------------

  describe("execute -- metering", () => {
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
  // execute -- TTS and embeddings routing
  // ---------------------------------------------------------------------------

  describe("execute -- TTS routing", () => {
    it("routes tts capability to synthesizeSpeech method", async () => {
      const meter = stubMeter();
      const socket = createSocket(meter);
      socket.register({
        name: "tts-provider",
        capabilities: ["tts"],
        async synthesizeSpeech() {
          return {
            result: { audioUrl: "https://example.com/out.mp3", durationSeconds: 3, format: "mp3", characterCount: 11 },
            cost: 0.005,
          };
        },
      });

      const result = await socket.execute<TTSOutput>({
        tenantId: "t-1",
        capability: "tts",
        input: { text: "Hello world" },
      });

      expect(result.audioUrl).toBe("https://example.com/out.mp3");
      expect(result.durationSeconds).toBe(3);
      expect(result.format).toBe("mp3");
      expect(result.characterCount).toBe(11);
      expect(meter.events).toHaveLength(1);
      expect(meter.events[0].capability).toBe("tts");
    });
  });

  describe("execute -- embeddings routing", () => {
    it("routes embeddings capability to embed method", async () => {
      const meter = stubMeter();
      const socket = createSocket(meter);
      socket.register({
        name: "embed-provider",
        capabilities: ["embeddings"],
        async embed() {
          return {
            result: { embeddings: [[0.1, 0.2, 0.3]], model: "text-embedding-3-small", totalTokens: 4 },
            cost: 0.0001,
          };
        },
      });

      const result = await socket.execute<EmbeddingsOutput>({
        tenantId: "t-1",
        capability: "embeddings",
        input: { input: "Hello" },
      });

      expect(result.embeddings).toEqual([[0.1, 0.2, 0.3]]);
      expect(result.model).toBe("text-embedding-3-small");
      expect(result.totalTokens).toBe(4);
      expect(meter.events).toHaveLength(1);
      expect(meter.events[0].capability).toBe("embeddings");
    });
  });

  // ---------------------------------------------------------------------------
  // execute -- error handling
  // ---------------------------------------------------------------------------

  describe("execute -- error handling", () => {
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
  // execute -- BYOK bypass
  // ---------------------------------------------------------------------------

  describe("execute -- BYOK bypass", () => {
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
  // execute -- budget check
  // ---------------------------------------------------------------------------

  describe("execute -- budget check", () => {
    let db: DrizzleDb;
    let budgetChecker: BudgetChecker;
    let budgetPool: import("@electric-sql/pglite").PGlite;

    beforeEach(async () => {
      const testDb = await createTestDb();
      db = testDb.db;
      budgetPool = testDb.pool;
      budgetChecker = new BudgetChecker(db, { cacheTtlMs: 1000 });
    });

    afterEach(async () => {
      await budgetPool?.close();
    });

    it("allows requests when budget is under limit", async () => {
      const meter = stubMeter();
      const socket = new AdapterSocket({ meter, budgetChecker });
      socket.register(stubAdapter());

      const result = await socket.execute<TranscriptionOutput>({
        tenantId: "t-1",
        capability: "transcription",
        input: { audioUrl: "https://example.com/audio.mp3" },
        spendLimits: FREE_LIMITS,
      });

      expect(result.text).toBe("hello");
      expect(meter.events).toHaveLength(1);
    });

    it("blocks requests when hourly budget is exceeded", async () => {
      // Add events to exceed hourly limit ($0.50)
      const now = Date.now();
      await db.insert(meterEvents).values({
        id: "evt-1",
        tenant: "t-1",
        cost: 0.3,
        charge: 0.6,
        capability: "chat",
        provider: "replicate",
        timestamp: now,
      });

      const meter = stubMeter();
      const socket = new AdapterSocket({ meter, budgetChecker });
      socket.register(stubAdapter());

      await expect(
        socket.execute({
          tenantId: "t-1",
          capability: "transcription",
          input: { audioUrl: "https://example.com/audio.mp3" },
          spendLimits: FREE_LIMITS,
        }),
      ).rejects.toThrow("Hourly spending limit exceeded");

      expect(meter.events).toHaveLength(0); // No meter event emitted
    });

    it("blocks requests when monthly budget is exceeded", async () => {
      // Add old events to exceed monthly limit but not hourly ($5.00)
      const now = Date.now();
      const twoHoursAgo = now - 2 * 60 * 60 * 1000;
      await db.insert(meterEvents).values({
        id: "evt-1",
        tenant: "t-monthly",
        cost: 2.5,
        charge: 5.0,
        capability: "chat",
        provider: "replicate",
        timestamp: twoHoursAgo,
      });

      const meter = stubMeter();
      const socket = new AdapterSocket({ meter, budgetChecker });
      socket.register(stubAdapter());

      await expect(
        socket.execute({
          tenantId: "t-monthly",
          capability: "transcription",
          input: { audioUrl: "https://example.com/audio.mp3" },
          spendLimits: FREE_LIMITS,
        }),
      ).rejects.toThrow("Monthly spending limit exceeded");

      expect(meter.events).toHaveLength(0);
    });

    it("skips budget check when spendLimits is not provided", async () => {
      // Even though budget is exceeded, no limits means no check
      const now = Date.now();
      await db.insert(meterEvents).values({
        id: "evt-1",
        tenant: "t-1",
        cost: 3.0,
        charge: 6.0,
        capability: "chat",
        provider: "replicate",
        timestamp: now,
      });

      const meter = stubMeter();
      const socket = new AdapterSocket({ meter, budgetChecker });
      socket.register(stubAdapter());

      const result = await socket.execute<TranscriptionOutput>({
        tenantId: "t-1",
        capability: "transcription",
        input: { audioUrl: "https://example.com/audio.mp3" },
        // No spendLimits provided
      });

      expect(result.text).toBe("hello");
      expect(meter.events).toHaveLength(1);
    });

    it("skips budget check when byok is true", async () => {
      // BYOK users bypass budget checks
      const now = Date.now();
      await db.insert(meterEvents).values({
        id: "evt-1",
        tenant: "t-1",
        cost: 3.0,
        charge: 6.0,
        capability: "chat",
        provider: "replicate",
        timestamp: now,
      });

      const meter = stubMeter();
      const socket = new AdapterSocket({ meter, budgetChecker });
      socket.register(stubAdapter());

      const result = await socket.execute<TranscriptionOutput>({
        tenantId: "t-1",
        capability: "transcription",
        input: { audioUrl: "https://example.com/audio.mp3" },
        spendLimits: FREE_LIMITS,
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
        spendLimits: FREE_LIMITS,
      });

      expect(result.text).toBe("hello");
    });

    it("includes httpStatus in error when budget exceeded", async () => {
      const now = Date.now();
      await db.insert(meterEvents).values({
        id: "evt-1",
        tenant: "t-1",
        cost: 0.3,
        charge: 0.6,
        capability: "chat",
        provider: "replicate",
        timestamp: now,
      });

      const meter = stubMeter();
      const socket = new AdapterSocket({ meter, budgetChecker });
      socket.register(stubAdapter());

      try {
        await socket.execute({
          tenantId: "t-1",
          capability: "transcription",
          input: { audioUrl: "https://example.com/audio.mp3" },
          spendLimits: FREE_LIMITS,
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
