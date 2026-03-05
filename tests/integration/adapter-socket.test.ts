import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlink } from "node:fs/promises";
import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../../src/test/db.js";
import type { DrizzleDb } from "../../src/db/index.js";
import { CreditLedger } from "../../src/monetization/credits/credit-ledger.js";
import { Credit } from "../../src/monetization/credit.js";
import { DrizzleMeterEmitter as MeterEmitter } from "../../src/monetization/metering/emitter.js";
import { DrizzleMeterEventRepository } from "../../src/monetization/metering/meter-event-repository.js";
import { AdapterSocket } from "../../src/monetization/socket/socket.js";
import type {
  AdapterResult,
  ImageGenerationOutput,
  ProviderAdapter,
  TTSOutput,
  TranscriptionOutput,
} from "../../src/monetization/adapters/types.js";

vi.mock("../../src/config/logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

describe("E2E: adapter socket — meters capability usage and charges credits correctly", () => {
  let db: DrizzleDb;
  let pool: PGlite;
  let ledger: CreditLedger;
  let meter: MeterEmitter;
  let socket: AdapterSocket;
  let walPath: string;
  let dlqPath: string;
  let TENANT_ID: string;

  beforeEach(async () => {
    const suffix = randomUUID();
    walPath = join(tmpdir(), `wopr-e2e-adapter-socket-wal-${suffix}.jsonl`);
    dlqPath = join(tmpdir(), `wopr-e2e-adapter-socket-dlq-${suffix}.jsonl`);

    ({ db, pool } = await createTestDb());

    TENANT_ID = `e2e-socket-${randomUUID().slice(0, 8)}`;
    ledger = new CreditLedger(db);

    meter = new MeterEmitter(new DrizzleMeterEventRepository(db), {
      flushIntervalMs: 60_000,
      batchSize: 10000,
      walPath,
      dlqPath,
    });

    socket = new AdapterSocket({
      meter,
      defaultMargin: 1.3,
    });
  });

  afterEach(async () => {
    try {
      await meter.flush();
      meter.close();
    } finally {
      await pool.close();
      await unlink(walPath).catch(() => {});
      await unlink(dlqPath).catch(() => {});
    }
  });

  it("image generation — metered and charged", async () => {
    socket.register({
      name: "fake-image-gen",
      capabilities: ["image-generation"],
      selfHosted: false,
      async generateImage() {
        return {
          result: { images: ["https://cdn.example.com/img.png"], model: "test-model" },
          cost: Credit.fromDollars(0.01),
        } satisfies AdapterResult<ImageGenerationOutput>;
      },
    });

    await ledger.credit(TENANT_ID, Credit.fromCents(500), "purchase", "Initial credits");

    const result = await socket.execute<ImageGenerationOutput>({
      tenantId: TENANT_ID,
      capability: "image-generation",
      input: { prompt: "a red cat", width: 512, height: 512 },
    });
    expect(result.images).toHaveLength(1);

    await meter.flush();

    const events = await meter.queryEvents(TENANT_ID);
    expect(events).toHaveLength(1);
    expect(events[0].capability).toBe("image-generation");
    expect(events[0].tenant).toBe(TENANT_ID);

    // charge = cost * margin = 0.01 * 1.3 = 0.013
    const chargeCredit = Credit.fromRaw(events[0].charge);
    expect(chargeCredit.toDollars()).toBeCloseTo(0.013, 6);

    // Debit from ledger, verify balance decreased
    await ledger.debit(TENANT_ID, chargeCredit, "adapter_usage", "image-generation usage", events[0].id);
    const balance = await ledger.balance(TENANT_ID);
    expect(balance.toCents()).toBeLessThan(500);
    expect(balance.isNegative()).toBe(false);
  });

  it("TTS — metered and charged", async () => {
    socket.register({
      name: "fake-tts",
      capabilities: ["tts"],
      selfHosted: false,
      async synthesizeSpeech() {
        return {
          result: { audioUrl: "https://cdn.example.com/speech.mp3", durationSeconds: 5, format: "mp3", characterCount: 42 },
          cost: Credit.fromDollars(0.005),
        } satisfies AdapterResult<TTSOutput>;
      },
    });

    const result = await socket.execute<TTSOutput>({
      tenantId: TENANT_ID,
      capability: "tts",
      input: { text: "Hello world" },
    });
    expect(result.audioUrl).toBe("https://cdn.example.com/speech.mp3");

    await meter.flush();

    const events = await meter.queryEvents(TENANT_ID);
    expect(events).toHaveLength(1);
    expect(events[0].capability).toBe("tts");
    expect(events[0].tenant).toBe(TENANT_ID);
    expect(Credit.fromRaw(events[0].cost).toDollars()).toBe(0.005);
  });

  it("margin applied correctly — 1.3x on $0.01 = $0.013", async () => {
    socket.register({
      name: "fake-margin-adapter",
      capabilities: ["image-generation"],
      selfHosted: false,
      async generateImage() {
        return {
          result: { images: ["https://cdn.example.com/img.png"], model: "test-model" },
          cost: Credit.fromDollars(0.01),
        } satisfies AdapterResult<ImageGenerationOutput>;
      },
    });

    await socket.execute<ImageGenerationOutput>({
      tenantId: TENANT_ID,
      capability: "image-generation",
      input: { prompt: "test" },
    });

    await meter.flush();

    const events = await meter.queryEvents(TENANT_ID);
    expect(events).toHaveLength(1);

    const cost = Credit.fromRaw(events[0].cost);
    const charge = Credit.fromRaw(events[0].charge);

    expect(cost.toDollars()).toBe(0.01);
    expect(charge.toDollars()).toBeCloseTo(0.013, 6);
    expect(charge.toRaw() / cost.toRaw()).toBeCloseTo(1.3, 4);
  });

  it("adapter error — no meter event emitted, balance unchanged", async () => {
    socket.register({
      name: "failing-adapter",
      capabilities: ["transcription"],
      async transcribe() {
        throw new Error("provider exploded");
      },
    });

    await ledger.credit(TENANT_ID, Credit.fromCents(500), "purchase", "Initial credits");
    const balanceBefore = await ledger.balance(TENANT_ID);

    await expect(
      socket.execute({
        tenantId: TENANT_ID,
        capability: "transcription",
        input: { audioUrl: "https://example.com/audio.mp3" },
      }),
    ).rejects.toThrow("provider exploded");

    await meter.flush();

    const events = await meter.queryEvents(TENANT_ID);
    expect(events).toHaveLength(0);

    const balanceAfter = await ledger.balance(TENANT_ID);
    expect(balanceAfter.toRaw()).toBe(balanceBefore.toRaw());
  });

  it("multiple capabilities in sequence — 3 meter events, charges sum correctly", async () => {
    socket.register({
      name: "fake-image-gen",
      capabilities: ["image-generation"],
      selfHosted: false,
      async generateImage() {
        return {
          result: { images: ["https://cdn.example.com/img.png"], model: "test-model" },
          cost: Credit.fromDollars(0.01),
        } satisfies AdapterResult<ImageGenerationOutput>;
      },
    });

    socket.register({
      name: "fake-tts",
      capabilities: ["tts"],
      selfHosted: false,
      async synthesizeSpeech() {
        return {
          result: { audioUrl: "https://cdn.example.com/speech.mp3", durationSeconds: 5, format: "mp3", characterCount: 42 },
          cost: Credit.fromDollars(0.005),
        } satisfies AdapterResult<TTSOutput>;
      },
    });

    socket.register({
      name: "fake-transcription",
      capabilities: ["transcription"],
      selfHosted: false,
      async transcribe() {
        return {
          result: { text: "hello world", detectedLanguage: "en", durationSeconds: 10 },
          cost: Credit.fromDollars(0.02),
        } satisfies AdapterResult<TranscriptionOutput>;
      },
    });

    await socket.execute<ImageGenerationOutput>({
      tenantId: TENANT_ID,
      capability: "image-generation",
      input: { prompt: "test" },
    });

    await socket.execute<TTSOutput>({
      tenantId: TENANT_ID,
      capability: "tts",
      input: { text: "hello" },
    });

    await socket.execute<TranscriptionOutput>({
      tenantId: TENANT_ID,
      capability: "transcription",
      input: { audioUrl: "https://example.com/audio.mp3" },
    });

    await meter.flush();

    const events = await meter.queryEvents(TENANT_ID);
    expect(events).toHaveLength(3);

    const capabilities = events.map((e) => e.capability).sort();
    expect(capabilities).toEqual(["image-generation", "transcription", "tts"]);

    // total charges = sum of individual costs * 1.3 margin
    // image-gen: 0.01 * 1.3 = 0.013
    // tts: 0.005 * 1.3 = 0.0065
    // transcription: 0.02 * 1.3 = 0.026
    // total = 0.0455
    const totalCharge = events.reduce((sum, e) => sum + Credit.fromRaw(e.charge).toDollars(), 0);
    expect(totalCharge).toBeCloseTo(0.0455, 4);
  });
});
