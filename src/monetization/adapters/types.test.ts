import { describe, expect, it } from "vitest";
import type {
  AdapterCapability,
  AdapterResult,
  EmbeddingsInput,
  EmbeddingsOutput,
  ImageGenerationInput,
  ImageGenerationOutput,
  ProviderAdapter,
  TTSInput,
  TTSOutput,
  TextGenerationInput,
  TextGenerationOutput,
} from "./types.js";
import { withMargin } from "./types.js";

describe("ImageGenerationInput/Output types", () => {
  it("accepts a minimal image generation input", () => {
    const input: ImageGenerationInput = { prompt: "a cat in space" };
    expect(input.prompt).toBe("a cat in space");
    expect(input.negativePrompt).toBeUndefined();
    expect(input.width).toBeUndefined();
    expect(input.height).toBeUndefined();
    expect(input.count).toBeUndefined();
  });

  it("accepts a fully specified image generation input", () => {
    const input: ImageGenerationInput = {
      prompt: "a cat in space",
      negativePrompt: "blurry",
      width: 1024,
      height: 768,
      count: 4,
    };
    expect(input.prompt).toBe("a cat in space");
    expect(input.negativePrompt).toBe("blurry");
    expect(input.width).toBe(1024);
    expect(input.height).toBe(768);
    expect(input.count).toBe(4);
  });

  it("creates a valid image generation output", () => {
    const output: ImageGenerationOutput = {
      images: ["https://example.com/img1.png", "https://example.com/img2.png"],
      model: "sdxl-turbo",
    };
    expect(output.images).toHaveLength(2);
    expect(output.model).toBe("sdxl-turbo");
  });
});

describe("TextGenerationInput/Output types", () => {
  it("accepts a minimal text generation input", () => {
    const input: TextGenerationInput = { prompt: "Hello world" };
    expect(input.prompt).toBe("Hello world");
    expect(input.model).toBeUndefined();
    expect(input.maxTokens).toBeUndefined();
    expect(input.temperature).toBeUndefined();
  });

  it("accepts a fully specified text generation input", () => {
    const input: TextGenerationInput = {
      prompt: "Explain quantum computing",
      model: "llama-3-70b",
      maxTokens: 2048,
      temperature: 0.7,
    };
    expect(input.prompt).toBe("Explain quantum computing");
    expect(input.model).toBe("llama-3-70b");
    expect(input.maxTokens).toBe(2048);
    expect(input.temperature).toBe(0.7);
  });

  it("creates a valid text generation output", () => {
    const output: TextGenerationOutput = {
      text: "Quantum computing uses qubits...",
      model: "llama-3-70b",
      usage: { inputTokens: 10, outputTokens: 50 },
    };
    expect(output.text).toBe("Quantum computing uses qubits...");
    expect(output.model).toBe("llama-3-70b");
    expect(output.usage.inputTokens).toBe(10);
    expect(output.usage.outputTokens).toBe(50);
  });
});

describe("ProviderAdapter with new capabilities", () => {
  it("supports image-generation capability", () => {
    const adapter: ProviderAdapter = {
      name: "test-image-adapter",
      capabilities: ["image-generation"],
      async generateImage(_input: ImageGenerationInput) {
        return {
          result: { images: ["data:image/png;base64,..."], model: "test-model" },
          cost: 0.02,
        };
      },
    };

    expect(adapter.name).toBe("test-image-adapter");
    expect(adapter.capabilities).toContain("image-generation");
    expect(adapter.generateImage).toBeDefined();
  });

  it("supports text-generation capability", () => {
    const adapter: ProviderAdapter = {
      name: "test-text-adapter",
      capabilities: ["text-generation"],
      async generateText(_input: TextGenerationInput) {
        return {
          result: {
            text: "Generated text",
            model: "test-model",
            usage: { inputTokens: 5, outputTokens: 20 },
          },
          cost: 0.001,
        };
      },
    };

    expect(adapter.name).toBe("test-text-adapter");
    expect(adapter.capabilities).toContain("text-generation");
    expect(adapter.generateText).toBeDefined();
  });

  it("supports multiple capabilities on one adapter", () => {
    const adapter: ProviderAdapter = {
      name: "multi-adapter",
      capabilities: ["transcription", "image-generation", "text-generation"],
      async transcribe() {
        return {
          result: { text: "", detectedLanguage: "en", durationSeconds: 0 },
          cost: 0,
        };
      },
      async generateImage() {
        return { result: { images: [], model: "m" }, cost: 0 };
      },
      async generateText() {
        return {
          result: { text: "", model: "m", usage: { inputTokens: 0, outputTokens: 0 } },
          cost: 0,
        };
      },
    };

    expect(adapter.capabilities).toHaveLength(3);
    expect(adapter.transcribe).toBeDefined();
    expect(adapter.generateImage).toBeDefined();
    expect(adapter.generateText).toBeDefined();
  });

  it("generateImage returns AdapterResult with cost and optional charge", async () => {
    const adapter: ProviderAdapter = {
      name: "cost-test",
      capabilities: ["image-generation"],
      async generateImage() {
        const cost = 0.05;
        return {
          result: { images: ["img1.png"], model: "sdxl" },
          cost,
          charge: withMargin(cost),
        };
      },
    };

    const result = (await adapter.generateImage?.({
      prompt: "test",
    })) as AdapterResult<ImageGenerationOutput>;
    expect(result.cost).toBe(0.05);
    expect(result.charge).toBeCloseTo(0.065, 6);
  });

  it("generateText returns AdapterResult with cost and optional charge", async () => {
    const adapter: ProviderAdapter = {
      name: "cost-test",
      capabilities: ["text-generation"],
      async generateText() {
        const cost = 0.003;
        return {
          result: {
            text: "hello",
            model: "llama-3",
            usage: { inputTokens: 10, outputTokens: 5 },
          },
          cost,
          charge: withMargin(cost),
        };
      },
    };

    const result = (await adapter.generateText?.({
      prompt: "test",
    })) as AdapterResult<TextGenerationOutput>;
    expect(result.cost).toBe(0.003);
    expect(result.charge).toBeCloseTo(0.0039, 6);
  });
});

describe("TTSInput/Output types", () => {
  it("accepts a minimal TTS input", () => {
    const input: TTSInput = { text: "Hello world" };
    expect(input.text).toBe("Hello world");
    expect(input.voice).toBeUndefined();
    expect(input.format).toBeUndefined();
    expect(input.speed).toBeUndefined();
  });

  it("accepts a fully specified TTS input", () => {
    const input: TTSInput = {
      text: "Hello world",
      voice: "alloy",
      format: "mp3",
      speed: 1.5,
    };
    expect(input.text).toBe("Hello world");
    expect(input.voice).toBe("alloy");
    expect(input.format).toBe("mp3");
    expect(input.speed).toBe(1.5);
  });

  it("creates a valid TTS output", () => {
    const output: TTSOutput = {
      audioUrl: "https://example.com/audio.mp3",
      durationSeconds: 3.5,
      format: "mp3",
      characterCount: 11,
    };
    expect(output.audioUrl).toBe("https://example.com/audio.mp3");
    expect(output.durationSeconds).toBe(3.5);
    expect(output.format).toBe("mp3");
    expect(output.characterCount).toBe(11);
  });
});

describe("EmbeddingsInput/Output types", () => {
  it("accepts a single string input", () => {
    const input: EmbeddingsInput = { input: "Hello world" };
    expect(input.input).toBe("Hello world");
    expect(input.model).toBeUndefined();
    expect(input.dimensions).toBeUndefined();
  });

  it("accepts an array of strings input", () => {
    const input: EmbeddingsInput = { input: ["Hello", "World"] };
    expect(input.input).toHaveLength(2);
  });

  it("accepts a fully specified embeddings input", () => {
    const input: EmbeddingsInput = {
      input: "Hello world",
      model: "text-embedding-3-small",
      dimensions: 256,
    };
    expect(input.input).toBe("Hello world");
    expect(input.model).toBe("text-embedding-3-small");
    expect(input.dimensions).toBe(256);
  });

  it("creates a valid embeddings output", () => {
    const output: EmbeddingsOutput = {
      embeddings: [[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]],
      model: "text-embedding-3-small",
      totalTokens: 8,
    };
    expect(output.embeddings).toHaveLength(2);
    expect(output.embeddings[0]).toEqual([0.1, 0.2, 0.3]);
    expect(output.model).toBe("text-embedding-3-small");
    expect(output.totalTokens).toBe(8);
  });
});

describe("ProviderAdapter with TTS and embeddings capabilities", () => {
  it("supports tts capability", () => {
    const adapter: ProviderAdapter = {
      name: "test-tts-adapter",
      capabilities: ["tts"],
      async synthesizeSpeech(_input: TTSInput) {
        return {
          result: { audioUrl: "https://example.com/audio.mp3", durationSeconds: 3, format: "mp3", characterCount: 11 },
          cost: 0.005,
        };
      },
    };

    expect(adapter.name).toBe("test-tts-adapter");
    expect(adapter.capabilities).toContain("tts");
    expect(adapter.synthesizeSpeech).toBeDefined();
  });

  it("supports embeddings capability", () => {
    const adapter: ProviderAdapter = {
      name: "test-embed-adapter",
      capabilities: ["embeddings"],
      async embed(_input: EmbeddingsInput) {
        return {
          result: { embeddings: [[0.1, 0.2]], model: "test-model", totalTokens: 4 },
          cost: 0.0001,
        };
      },
    };

    expect(adapter.name).toBe("test-embed-adapter");
    expect(adapter.capabilities).toContain("embeddings");
    expect(adapter.embed).toBeDefined();
  });

  it("synthesizeSpeech returns AdapterResult with cost and optional charge", async () => {
    const adapter: ProviderAdapter = {
      name: "cost-test",
      capabilities: ["tts"],
      async synthesizeSpeech() {
        const cost = 0.01;
        return {
          result: { audioUrl: "https://example.com/audio.mp3", durationSeconds: 5, format: "mp3", characterCount: 50 },
          cost,
          charge: withMargin(cost),
        };
      },
    };

    const result = (await adapter.synthesizeSpeech?.({
      text: "test",
    })) as AdapterResult<TTSOutput>;
    expect(result.cost).toBe(0.01);
    expect(result.charge).toBeCloseTo(0.013, 6);
  });

  it("embed returns AdapterResult with cost and optional charge", async () => {
    const adapter: ProviderAdapter = {
      name: "cost-test",
      capabilities: ["embeddings"],
      async embed() {
        const cost = 0.0002;
        return {
          result: { embeddings: [[0.1, 0.2, 0.3]], model: "test-model", totalTokens: 10 },
          cost,
          charge: withMargin(cost),
        };
      },
    };

    const result = (await adapter.embed?.({
      input: "test",
    })) as AdapterResult<EmbeddingsOutput>;
    expect(result.cost).toBe(0.0002);
    expect(result.charge).toBeCloseTo(0.00026, 6);
  });
});

describe("AdapterCapability includes new capabilities", () => {
  it("image-generation is a valid capability", () => {
    const cap: AdapterCapability = "image-generation";
    expect(cap).toBe("image-generation");
  });

  it("text-generation is a valid capability", () => {
    const cap: AdapterCapability = "text-generation";
    expect(cap).toBe("text-generation");
  });

  it("tts is a valid capability", () => {
    const cap: AdapterCapability = "tts";
    expect(cap).toBe("tts");
  });

  it("embeddings is a valid capability", () => {
    const cap: AdapterCapability = "embeddings";
    expect(cap).toBe("embeddings");
  });
});
