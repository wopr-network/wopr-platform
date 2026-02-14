import { describe, expect, it } from "vitest";
import type {
  AdapterCapability,
  AdapterResult,
  ImageGenerationInput,
  ImageGenerationOutput,
  ProviderAdapter,
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

    const result = (await adapter.generateImage!({
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

    const result = (await adapter.generateText!({
      prompt: "test",
    })) as AdapterResult<TextGenerationOutput>;
    expect(result.cost).toBe(0.003);
    expect(result.charge).toBeCloseTo(0.0039, 6);
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
});
