/**
 * Protocol handlers — native Anthropic and OpenAI API compatibility.
 *
 * Mounts at:
 *   /v1/anthropic/* — Anthropic Messages API (x-api-key auth)
 *   /v1/openai/*    — OpenAI Chat Completions API (Bearer auth)
 */

export { createAnthropicRoutes } from "./anthropic.js";
export type { ProtocolDeps } from "./deps.js";
export { createOpenAIRoutes } from "./openai.js";
export {
  type AnthropicError,
  type AnthropicRequest,
  type AnthropicResponse,
  anthropicToOpenAI,
  estimateAnthropicCost,
  estimateOpenAICost,
  mapToAnthropicError,
  type OpenAIRequest,
  type OpenAIResponse,
  openAIResponseToAnthropic,
} from "./translate.js";
