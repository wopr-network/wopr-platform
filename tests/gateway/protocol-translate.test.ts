import { describe, it, expect } from "vitest";
import {
  anthropicToOpenAI,
  openAIResponseToAnthropic,
  mapToAnthropicError,
  estimateAnthropicCost,
  estimateOpenAICost,
  type AnthropicRequest,
  type OpenAIResponse,
} from "../../src/gateway/protocol/translate.js";

describe("anthropicToOpenAI", () => {
  it("converts a basic text request", () => {
    const req: AnthropicRequest = {
      model: "claude-3-sonnet",
      messages: [{ role: "user", content: "Hello" }],
      max_tokens: 100,
    };
    const result = anthropicToOpenAI(req);
    expect(result.model).toBe("claude-3-sonnet");
    expect(result.max_tokens).toBe(100);
    expect(result.messages).toEqual([{ role: "user", content: "Hello" }]);
  });

  it("converts string system prompt to system message", () => {
    const req: AnthropicRequest = {
      model: "claude-3-sonnet",
      messages: [{ role: "user", content: "Hi" }],
      max_tokens: 100,
      system: "You are helpful.",
    };
    const result = anthropicToOpenAI(req);
    expect(result.messages[0]).toEqual({ role: "system", content: "You are helpful." });
    expect(result.messages[1]).toEqual({ role: "user", content: "Hi" });
  });

  it("converts array system prompt to joined system message", () => {
    const req: AnthropicRequest = {
      model: "claude-3-sonnet",
      messages: [{ role: "user", content: "Hi" }],
      max_tokens: 100,
      system: [
        { type: "text", text: "Part 1" },
        { type: "text", text: "Part 2" },
      ],
    };
    const result = anthropicToOpenAI(req);
    expect(result.messages[0]).toEqual({ role: "system", content: "Part 1\n\nPart 2" });
  });

  it("passes through temperature, top_p, stop_sequences, and metadata.user_id", () => {
    const req: AnthropicRequest = {
      model: "m",
      messages: [{ role: "user", content: "x" }],
      max_tokens: 10,
      temperature: 0.5,
      top_p: 0.9,
      stop_sequences: ["STOP"],
      metadata: { user_id: "u123" },
    };
    const result = anthropicToOpenAI(req);
    expect(result.temperature).toBe(0.5);
    expect(result.top_p).toBe(0.9);
    expect(result.stop).toEqual(["STOP"]);
    expect(result.user).toBe("u123");
  });

  it("converts tools from Anthropic to OpenAI format", () => {
    const req: AnthropicRequest = {
      model: "m",
      messages: [{ role: "user", content: "x" }],
      max_tokens: 10,
      tools: [{ name: "get_weather", description: "Get weather", input_schema: { type: "object", properties: {} } }],
    };
    const result = anthropicToOpenAI(req);
    expect(result.tools).toEqual([
      {
        type: "function",
        function: { name: "get_weather", description: "Get weather", parameters: { type: "object", properties: {} } },
      },
    ]);
  });

  it("converts tool_choice auto -> auto", () => {
    const req: AnthropicRequest = {
      model: "m",
      messages: [{ role: "user", content: "x" }],
      max_tokens: 10,
      tool_choice: { type: "auto" },
    };
    expect(anthropicToOpenAI(req).tool_choice).toBe("auto");
  });

  it("converts tool_choice any -> required", () => {
    const req: AnthropicRequest = {
      model: "m",
      messages: [{ role: "user", content: "x" }],
      max_tokens: 10,
      tool_choice: { type: "any" },
    };
    expect(anthropicToOpenAI(req).tool_choice).toBe("required");
  });

  it("converts tool_choice specific tool", () => {
    const req: AnthropicRequest = {
      model: "m",
      messages: [{ role: "user", content: "x" }],
      max_tokens: 10,
      tool_choice: { type: "tool", name: "my_tool" },
    };
    expect(anthropicToOpenAI(req).tool_choice).toEqual({ type: "function", function: { name: "my_tool" } });
  });

  it("converts assistant message with tool_use blocks", () => {
    const req: AnthropicRequest = {
      model: "m",
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "Let me check" },
            { type: "tool_use", id: "tc1", name: "get_weather", input: { city: "NYC" } },
          ],
        },
      ],
      max_tokens: 10,
    };
    const result = anthropicToOpenAI(req);
    expect(result.messages[0]).toEqual({
      role: "assistant",
      content: "Let me check",
      tool_calls: [
        {
          id: "tc1",
          type: "function",
          function: { name: "get_weather", arguments: '{"city":"NYC"}' },
        },
      ],
    });
  });

  it("converts user message with tool_result blocks", () => {
    const req: AnthropicRequest = {
      model: "m",
      messages: [
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tc1", content: "72F and sunny" }],
        },
      ],
      max_tokens: 10,
    };
    const result = anthropicToOpenAI(req);
    expect(result.messages[0]).toEqual({ role: "tool", content: "72F and sunny", tool_call_id: "tc1" });
  });

  it("handles tool_result with array content blocks", () => {
    const req: AnthropicRequest = {
      model: "m",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tc1",
              content: [
                { type: "text", text: "line1" },
                { type: "text", text: "line2" },
              ],
            },
          ],
        },
      ],
      max_tokens: 10,
    };
    const result = anthropicToOpenAI(req);
    expect(result.messages[0].content).toBe("line1\nline2");
  });

  it("handles empty content array in user message", () => {
    const req: AnthropicRequest = {
      model: "m",
      messages: [{ role: "user", content: [] }],
      max_tokens: 10,
    };
    const result = anthropicToOpenAI(req);
    expect(result.messages[0]).toEqual({ role: "user", content: "" });
  });

  it("passes stream flag through", () => {
    const req: AnthropicRequest = {
      model: "m",
      messages: [{ role: "user", content: "x" }],
      max_tokens: 10,
      stream: true,
    };
    expect(anthropicToOpenAI(req).stream).toBe(true);
  });
});

describe("openAIResponseToAnthropic", () => {
  const baseResponse: OpenAIResponse = {
    id: "chatcmpl-123",
    object: "chat.completion",
    created: 1700000000,
    model: "gpt-4",
    choices: [{ index: 0, message: { role: "assistant", content: "Hello!" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };

  it("converts a basic text response", () => {
    const result = openAIResponseToAnthropic(baseResponse, "claude-3-sonnet");
    expect(result.id).toBe("msg_chatcmpl-123");
    expect(result.type).toBe("message");
    expect(result.role).toBe("assistant");
    expect(result.model).toBe("claude-3-sonnet");
    expect(result.content).toEqual([{ type: "text", text: "Hello!" }]);
    expect(result.stop_reason).toBe("end_turn");
    expect(result.usage).toEqual({ input_tokens: 10, output_tokens: 5 });
  });

  it("preserves msg_ prefix if already present", () => {
    const res = { ...baseResponse, id: "msg_abc" };
    expect(openAIResponseToAnthropic(res, "m").id).toBe("msg_abc");
  });

  it("maps finish_reason length -> max_tokens", () => {
    const res = {
      ...baseResponse,
      choices: [{ ...baseResponse.choices[0], finish_reason: "length" as const }],
    };
    expect(openAIResponseToAnthropic(res, "m").stop_reason).toBe("max_tokens");
  });

  it("maps finish_reason tool_calls -> tool_use", () => {
    const res = {
      ...baseResponse,
      choices: [{ ...baseResponse.choices[0], finish_reason: "tool_calls" as const }],
    };
    expect(openAIResponseToAnthropic(res, "m").stop_reason).toBe("tool_use");
  });

  it("maps finish_reason null -> null", () => {
    const res = { ...baseResponse, choices: [{ ...baseResponse.choices[0], finish_reason: null }] };
    expect(openAIResponseToAnthropic(res, "m").stop_reason).toBeNull();
  });

  it("converts tool calls in response", () => {
    const res: OpenAIResponse = {
      ...baseResponse,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "get_weather", arguments: '{"city":"NYC"}' },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    };
    const result = openAIResponseToAnthropic(res, "m");
    expect(result.content).toEqual([
      {
        type: "tool_use",
        id: "call_1",
        name: "get_weather",
        input: { city: "NYC" },
      },
    ]);
  });

  it("handles malformed tool call arguments gracefully", () => {
    const res: OpenAIResponse = {
      ...baseResponse,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "fn", arguments: "not-json" },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    };
    const result = openAIResponseToAnthropic(res, "m");
    expect(result.content[0]).toMatchObject({ type: "tool_use", input: {} });
  });

  it("handles empty choices array", () => {
    const res: OpenAIResponse = { ...baseResponse, choices: [] };
    const result = openAIResponseToAnthropic(res, "m");
    expect(result.content).toEqual([]);
    expect(result.stop_reason).toBeNull();
  });

  it("defaults usage to 0 when missing", () => {
    const res: OpenAIResponse = { ...baseResponse, usage: undefined };
    const result = openAIResponseToAnthropic(res, "m");
    expect(result.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
  });
});

describe("mapToAnthropicError", () => {
  it("maps 400 to invalid_request_error", () => {
    const { status, body } = mapToAnthropicError(400, "bad request");
    expect(status).toBe(400);
    expect(body.error.type).toBe("invalid_request_error");
  });

  it("maps 401 to authentication_error", () => {
    expect(mapToAnthropicError(401, "x").body.error.type).toBe("authentication_error");
  });

  it("maps 429 to rate_limit_error", () => {
    expect(mapToAnthropicError(429, "x").body.error.type).toBe("rate_limit_error");
  });

  it("maps 502 to 529 overloaded_error", () => {
    const { status, body } = mapToAnthropicError(502, "bad gateway");
    expect(status).toBe(529);
    expect(body.error.type).toBe("api_error");
  });

  it("maps 503 to 529", () => {
    expect(mapToAnthropicError(503, "x").status).toBe(529);
  });

  it("maps 529 to overloaded_error", () => {
    expect(mapToAnthropicError(529, "x").body.error.type).toBe("overloaded_error");
  });

  it("maps unknown status to api_error with status 500", () => {
    const { status, body } = mapToAnthropicError(999, "x");
    expect(status).toBe(500);
    expect(body.error.type).toBe("api_error");
  });
});

describe("estimateAnthropicCost", () => {
  it("calculates blended cost", () => {
    const cost = estimateAnthropicCost({ input_tokens: 1000, output_tokens: 500 });
    expect(cost).toBeCloseTo(0.003 + 0.0075, 6);
  });
});

describe("estimateOpenAICost", () => {
  it("calculates blended cost", () => {
    const cost = estimateOpenAICost({ prompt_tokens: 1000, completion_tokens: 500 });
    expect(cost).toBeCloseTo(0.001 + 0.001, 6);
  });
});
