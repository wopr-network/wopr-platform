/**
 * Format translation — bidirectional Anthropic <-> OpenAI message conversion.
 *
 * When the gateway routes an Anthropic-format request through an OpenAI-compatible
 * provider (e.g., OpenRouter), it must translate the request *and* the response.
 * These functions handle that conversion losslessly for the subset of features
 * both APIs share (text, tool use, system messages).
 */

// ---------------------------------------------------------------------------
// Anthropic types (request/response shapes the Anthropic SDK sends/expects)
// ---------------------------------------------------------------------------

export interface AnthropicContentBlock {
  type: "text" | "tool_use" | "tool_result";
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string | AnthropicContentBlock[];
}

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

export interface AnthropicRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: string | Array<{ type: "text"; text: string }>;
  max_tokens: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  stream?: boolean;
  tools?: AnthropicTool[];
  tool_choice?: AnthropicToolChoice;
  metadata?: { user_id?: string };
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

export type AnthropicToolChoice = { type: "auto" } | { type: "any" } | { type: "tool"; name: string };

export interface AnthropicResponse {
  id: string;
  type: "message";
  role: "assistant";
  content: AnthropicContentBlock[];
  model: string;
  stop_reason: "end_turn" | "max_tokens" | "stop_sequence" | "tool_use" | null;
  stop_sequence: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

// ---------------------------------------------------------------------------
// OpenAI types (request/response shapes for OpenAI-compatible providers)
// ---------------------------------------------------------------------------

export interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  name?: string;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface OpenAIRequest {
  model: string;
  messages: OpenAIMessage[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string[];
  stream?: boolean;
  tools?: OpenAITool[];
  tool_choice?: OpenAIToolChoice;
  user?: string;
}

export interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

export type OpenAIToolChoice = "none" | "auto" | "required" | { type: "function"; function: { name: string } };

export interface OpenAIChoice {
  index: number;
  message: OpenAIMessage;
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null;
}

export interface OpenAIResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: OpenAIChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

// ---------------------------------------------------------------------------
// Anthropic -> OpenAI translation
// ---------------------------------------------------------------------------

/** Convert an Anthropic Messages API request into an OpenAI Chat Completions request. */
export function anthropicToOpenAI(req: AnthropicRequest): OpenAIRequest {
  const messages: OpenAIMessage[] = [];

  // System message: Anthropic has top-level `system`, OpenAI uses a system role message
  if (req.system) {
    const systemText = typeof req.system === "string" ? req.system : req.system.map((b) => b.text).join("\n\n");
    messages.push({ role: "system", content: systemText });
  }

  // Convert message history
  for (const msg of req.messages) {
    if (msg.role === "user") {
      messages.push(...translateAnthropicUserMessage(msg));
    } else {
      messages.push(...translateAnthropicAssistantMessage(msg));
    }
  }

  const result: OpenAIRequest = {
    model: req.model,
    messages,
    max_tokens: req.max_tokens,
    stream: req.stream,
  };

  if (req.temperature !== undefined) result.temperature = req.temperature;
  if (req.top_p !== undefined) result.top_p = req.top_p;
  if (req.stop_sequences) result.stop = req.stop_sequences;
  if (req.metadata?.user_id) result.user = req.metadata.user_id;

  // Tools
  if (req.tools?.length) {
    result.tools = req.tools.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    }));
  }

  // Tool choice
  if (req.tool_choice) {
    result.tool_choice = translateAnthropicToolChoice(req.tool_choice);
  }

  return result;
}

function translateAnthropicUserMessage(msg: AnthropicMessage): OpenAIMessage[] {
  // Simple string content
  if (typeof msg.content === "string") {
    return [{ role: "user", content: msg.content }];
  }

  const results: OpenAIMessage[] = [];
  for (const block of msg.content) {
    if (block.type === "text") {
      results.push({ role: "user", content: block.text ?? "" });
    } else if (block.type === "tool_result") {
      // Tool results in Anthropic are user messages; in OpenAI they're tool role messages
      const resultContent =
        typeof block.content === "string"
          ? block.content
          : Array.isArray(block.content)
            ? block.content
                .filter((b) => b.type === "text")
                .map((b) => b.text)
                .join("\n")
            : "";
      results.push({
        role: "tool",
        content: resultContent,
        tool_call_id: block.tool_use_id ?? "",
      });
    }
  }

  // If no content was generated (shouldn't happen), add empty user message
  if (results.length === 0) {
    results.push({ role: "user", content: "" });
  }

  return results;
}

function translateAnthropicAssistantMessage(msg: AnthropicMessage): OpenAIMessage[] {
  if (typeof msg.content === "string") {
    return [{ role: "assistant", content: msg.content }];
  }

  // Collect text and tool_use blocks
  const textParts: string[] = [];
  const toolCalls: OpenAIToolCall[] = [];

  for (const block of msg.content) {
    if (block.type === "text") {
      textParts.push(block.text ?? "");
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id ?? "",
        type: "function",
        function: {
          name: block.name ?? "",
          arguments: typeof block.input === "string" ? block.input : JSON.stringify(block.input ?? {}),
        },
      });
    }
  }

  const result: OpenAIMessage = {
    role: "assistant",
    content: textParts.length > 0 ? textParts.join("") : null,
  };

  if (toolCalls.length > 0) {
    result.tool_calls = toolCalls;
  }

  return [result];
}

function translateAnthropicToolChoice(choice: AnthropicToolChoice): OpenAIToolChoice {
  switch (choice.type) {
    case "auto":
      return "auto";
    case "any":
      return "required";
    case "tool":
      return { type: "function", function: { name: choice.name } };
    default:
      return "auto";
  }
}

// ---------------------------------------------------------------------------
// OpenAI -> Anthropic translation (response)
// ---------------------------------------------------------------------------

/** Convert an OpenAI Chat Completions response into an Anthropic Messages response. */
export function openAIResponseToAnthropic(res: OpenAIResponse, requestModel: string): AnthropicResponse {
  const choice = res.choices[0];
  const content: AnthropicContentBlock[] = [];

  if (choice) {
    // Text content
    if (choice.message.content) {
      content.push({ type: "text", text: choice.message.content });
    }

    // Tool calls
    if (choice.message.tool_calls) {
      for (const tc of choice.message.tool_calls) {
        let parsedInput: unknown;
        try {
          parsedInput = JSON.parse(tc.function.arguments);
        } catch {
          parsedInput = {};
        }
        content.push({
          type: "tool_use",
          id: tc.id,
          name: tc.function.name,
          input: parsedInput,
        });
      }
    }
  }

  return {
    id: res.id.startsWith("msg_") ? res.id : `msg_${res.id}`,
    type: "message",
    role: "assistant",
    content,
    model: requestModel,
    stop_reason: mapFinishReason(choice?.finish_reason ?? null),
    stop_sequence: null,
    usage: {
      input_tokens: res.usage?.prompt_tokens ?? 0,
      output_tokens: res.usage?.completion_tokens ?? 0,
    },
  };
}

function mapFinishReason(
  reason: "stop" | "length" | "tool_calls" | "content_filter" | null,
): AnthropicResponse["stop_reason"] {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "tool_calls":
      return "tool_use";
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Error code mapping
// ---------------------------------------------------------------------------

export interface AnthropicError {
  type: "error";
  error: {
    type: string;
    message: string;
  };
}

/** Map an HTTP status + provider error into Anthropic error format. */
export function mapToAnthropicError(status: number, message: string): { status: number; body: AnthropicError } {
  const errorType = mapStatusToAnthropicType(status);
  return {
    status: mapAnthropicErrorStatus(status),
    body: {
      type: "error",
      error: {
        type: errorType,
        message,
      },
    },
  };
}

function mapStatusToAnthropicType(status: number): string {
  if (status === 400) return "invalid_request_error";
  if (status === 401) return "authentication_error";
  if (status === 403) return "permission_error";
  if (status === 404) return "not_found_error";
  if (status === 429) return "rate_limit_error";
  if (status === 529) return "overloaded_error";
  return "api_error";
}

function mapAnthropicErrorStatus(status: number): number {
  // Keep standard error codes, map 502/503 to 529 (Anthropic's overloaded)
  if (status === 502 || status === 503) return 529;
  if (status >= 400 && status < 600) return status;
  return 500;
}

/** Estimate token cost from an Anthropic-format usage block. */
export function estimateAnthropicCost(usage: { input_tokens: number; output_tokens: number }): number {
  // Use approximate blended rates
  return usage.input_tokens * 0.000003 + usage.output_tokens * 0.000015;
}

/** Estimate token cost from an OpenAI-format usage block. */
export function estimateOpenAICost(usage: { prompt_tokens: number; completion_tokens: number }): number {
  return usage.prompt_tokens * 0.000001 + usage.completion_tokens * 0.000002;
}
