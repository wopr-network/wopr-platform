/**
 * Model discovery — GET /v1/models endpoint.
 *
 * Aggregates available models across all configured providers
 * (OpenRouter, Deepgram, ElevenLabs, Replicate, GPU backends).
 * Returns OpenAI-compatible model list format.
 */

import type { Context } from "hono";
import type { ProxyDeps } from "./proxy.js";
import type { GatewayAuthEnv } from "./service-key-auth.js";

export interface ModelInfo {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
  capability: string;
  tier: "standard" | "premium" | "byok";
}

export interface ModelsResponse {
  object: "list";
  data: ModelInfo[];
}

/**
 * GET /v1/models handler — aggregates available models from all configured providers.
 */
export function modelsHandler(deps: ProxyDeps) {
  return (_c: Context<GatewayAuthEnv>): Response => {
    const models: ModelInfo[] = [];
    const baseTimestamp = 1704067200; // 2024-01-01 00:00:00 UTC

    // OpenRouter models (LLM text-gen and embeddings)
    if (deps.providers.openrouter) {
      models.push(
        {
          id: "openai/gpt-4o",
          object: "model",
          created: baseTimestamp,
          owned_by: "openrouter",
          capability: "chat-completions",
          tier: "standard",
        },
        {
          id: "anthropic/claude-3.5-sonnet",
          object: "model",
          created: baseTimestamp,
          owned_by: "openrouter",
          capability: "chat-completions",
          tier: "standard",
        },
        {
          id: "text-embedding-3-small",
          object: "model",
          created: baseTimestamp,
          owned_by: "openrouter",
          capability: "embeddings",
          tier: "standard",
        },
      );
    }

    // Deepgram models (STT)
    if (deps.providers.deepgram) {
      models.push({
        id: "nova-2",
        object: "model",
        created: baseTimestamp,
        owned_by: "deepgram",
        capability: "transcription",
        tier: "standard",
      });
    }

    // ElevenLabs models (TTS)
    if (deps.providers.elevenlabs) {
      models.push({
        id: "eleven_multilingual_v2",
        object: "model",
        created: baseTimestamp,
        owned_by: "elevenlabs",
        capability: "tts",
        tier: "standard",
      });
    }

    // Replicate models (image-gen)
    if (deps.providers.replicate) {
      models.push({
        id: "sdxl",
        object: "model",
        created: baseTimestamp,
        owned_by: "replicate",
        capability: "image-generation",
        tier: "standard",
      });
    }

    // GPU backend models (private network)
    if (deps.providers.gpu) {
      if (deps.providers.gpu.textGen) {
        models.push({
          id: "llama-3.1-8b",
          object: "model",
          created: baseTimestamp,
          owned_by: "wopr-gpu",
          capability: "chat-completions",
          tier: "premium",
        });
      }

      if (deps.providers.gpu.tts) {
        models.push({
          id: "chatterbox-tts",
          object: "model",
          created: baseTimestamp,
          owned_by: "wopr-gpu",
          capability: "tts",
          tier: "premium",
        });
      }

      if (deps.providers.gpu.stt) {
        models.push({
          id: "faster-whisper-small",
          object: "model",
          created: baseTimestamp,
          owned_by: "wopr-gpu",
          capability: "transcription",
          tier: "premium",
        });
      }

      if (deps.providers.gpu.embeddings) {
        models.push({
          id: "qwen2-0.5b",
          object: "model",
          created: baseTimestamp,
          owned_by: "wopr-gpu",
          capability: "embeddings",
          tier: "premium",
        });
      }
    }

    const response: ModelsResponse = {
      object: "list",
      data: models,
    };

    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}
