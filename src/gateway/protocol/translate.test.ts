import { describe, expect, it } from "vitest";
import {
  type AnthropicRequest,
  anthropicToOpenAI,
  estimateAnthropicCost,
  estimateOpenAICost,
  mapToAnthropicError,
  type OpenAIResponse,
  openAIResponseToAnthropic,
} from "./translate.js";

// ---------------------------------------------------------------------------
// anthropicToOpenAI
// ---------------------------------------------------------------------------

describe("anthropicToOpenAI", () => {
  it("converts a basic text request", () => {
    const req: AnthropicRequest = {
      model: "claude-3-5-sonnet-20241022",
      messages: [{ role: "user", content: "Hello" }],
      max_tokens: 1024,
    };

    const result = anthropicToOpenAI(req);

    expect(result.model).toBe("claude-3-5-sonnet-20241022");
    expect(result.max_tokens).toBe(1024);
    expect(result.messages).toEqual([{ role: "user", content: "Hello" }]);
  });

  it("converts system string to system role message", () => {
    const req: AnthropicRequest = {
      model: "claude-3-5-sonnet-20241022",
      messages: [{ role: "user", content: "Hi" }],
      max_tokens: 100,
      system: "You are a helpful assistant.",
    };

    const result = anthropicToOpenAI(req);

    expect(result.messages[0]).toEqual({
      role: "system",
      content: "You are a helpful assistant.",
    });
    expect(result.messages[1]).toEqual({ role: "user", content: "Hi" });
  });

  it("converts system content blocks to system role message", () => {
    const req: AnthropicRequest = {
      model: "claude-3-5-sonnet-20241022",
      messages: [{ role: "user", content: "Hi" }],
      max_tokens: 100,
      system: [
        { type: "text", text: "First instruction." },
        { type: "text", text: "Second instruction." },
      ],
    };

    const result = anthropicToOpenAI(req);

    expect(result.messages[0]).toEqual({
      role: "system",
      content: "First instruction.\n\nSecond instruction.",
    });
  });

  it("passes through temperature, top_p, stop_sequences", () => {
    const req: AnthropicRequest = {
      model: "claude-3-5-sonnet-20241022",
      messages: [{ role: "user", content: "Hi" }],
      max_tokens: 100,
      temperature: 0.7,
      top_p: 0.9,
      stop_sequences: ["END", "STOP"],
    };

    const result = anthropicToOpenAI(req);

    expect(result.temperature).toBe(0.7);
    expect(result.top_p).toBe(0.9);
    expect(result.stop).toEqual(["END", "STOP"]);
  });

  it("converts user content blocks with text", () => {
    const req: AnthropicRequest = {
      model: "claude-3-5-sonnet-20241022",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "What is 2+2?" }],
        },
      ],
      max_tokens: 100,
    };

    const result = anthropicToOpenAI(req);

    expect(result.messages).toEqual([{ role: "user", content: "What is 2+2?" }]);
  });

  it("converts assistant tool_use blocks to tool_calls", () => {
    const req: AnthropicRequest = {
      model: "claude-3-5-sonnet-20241022",
      messages: [
        { role: "user", content: "Search for cats" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Let me search for that." },
            {
              type: "tool_use",
              id: "toolu_123",
              name: "web_search",
              input: { query: "cats" },
            },
          ],
        },
      ],
      max_tokens: 100,
    };

    const result = anthropicToOpenAI(req);
    const assistantMsg = result.messages[1];

    expect(assistantMsg.role).toBe("assistant");
    expect(assistantMsg.content).toBe("Let me search for that.");
    expect(assistantMsg.tool_calls).toEqual([
      {
        id: "toolu_123",
        type: "function",
        function: {
          name: "web_search",
          arguments: '{"query":"cats"}',
        },
      },
    ]);
  });

  it("converts user tool_result blocks to tool role messages", () => {
    const req: AnthropicRequest = {
      model: "claude-3-5-sonnet-20241022",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_123",
              content: "Found 10 results about cats.",
            },
          ],
        },
      ],
      max_tokens: 100,
    };

    const result = anthropicToOpenAI(req);

    expect(result.messages[0]).toEqual({
      role: "tool",
      content: "Found 10 results about cats.",
      tool_call_id: "toolu_123",
    });
  });

  it("converts tools to OpenAI function format", () => {
    const req: AnthropicRequest = {
      model: "claude-3-5-sonnet-20241022",
      messages: [{ role: "user", content: "Hi" }],
      max_tokens: 100,
      tools: [
        {
          name: "get_weather",
          description: "Get current weather",
          input_schema: {
            type: "object",
            properties: { location: { type: "string" } },
            required: ["location"],
          },
        },
      ],
    };

    const result = anthropicToOpenAI(req);

    expect(result.tools).toEqual([
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get current weather",
          parameters: {
            type: "object",
            properties: { location: { type: "string" } },
            required: ["location"],
          },
        },
      },
    ]);
  });

  it("converts tool_choice auto/any/tool", () => {
    const autoReq: AnthropicRequest = {
      model: "m",
      messages: [{ role: "user", content: "Hi" }],
      max_tokens: 1,
      tool_choice: { type: "auto" },
    };
    expect(anthropicToOpenAI(autoReq).tool_choice).toBe("auto");

    const anyReq: AnthropicRequest = {
      model: "m",
      messages: [{ role: "user", content: "Hi" }],
      max_tokens: 1,
      tool_choice: { type: "any" },
    };
    expect(anthropicToOpenAI(anyReq).tool_choice).toBe("required");

    const toolReq: AnthropicRequest = {
      model: "m",
      messages: [{ role: "user", content: "Hi" }],
      max_tokens: 1,
      tool_choice: { type: "tool", name: "get_weather" },
    };
    expect(anthropicToOpenAI(toolReq).tool_choice).toEqual({
      type: "function",
      function: { name: "get_weather" },
    });
  });

  it("passes stream flag through", () => {
    const req: AnthropicRequest = {
      model: "m",
      messages: [{ role: "user", content: "Hi" }],
      max_tokens: 1,
      stream: true,
    };
    expect(anthropicToOpenAI(req).stream).toBe(true);
  });

  it("converts metadata.user_id to user", () => {
    const req: AnthropicRequest = {
      model: "m",
      messages: [{ role: "user", content: "Hi" }],
      max_tokens: 1,
      metadata: { user_id: "user-42" },
    };
    expect(anthropicToOpenAI(req).user).toBe("user-42");
  });

  it("converts assistant string content directly", () => {
    const req: AnthropicRequest = {
      model: "m",
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there!" },
      ],
      max_tokens: 1,
    };
    const result = anthropicToOpenAI(req);
    const assistantMsg = result.messages[1];
    expect(assistantMsg.role).toBe("assistant");
    expect(assistantMsg.content).toBe("Hi there!");
  });

  it("uses default tool_choice for unknown types", () => {
    const req: AnthropicRequest = {
      model: "m",
      messages: [{ role: "user", content: "Hi" }],
      max_tokens: 1,
      // Cast to bypass TypeScript so we can test the default branch
      tool_choice: { type: "unknown_type" } as unknown as AnthropicRequest["tool_choice"],
    };
    expect(anthropicToOpenAI(req).tool_choice).toBe("auto");
  });
});

// ---------------------------------------------------------------------------
// openAIResponseToAnthropic
// ---------------------------------------------------------------------------

describe("openAIResponseToAnthropic", () => {
  it("converts a basic text response", () => {
    const res: OpenAIResponse = {
      id: "chatcmpl-abc123",
      object: "chat.completion",
      created: 1700000000,
      model: "gpt-4",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "Hello! How can I help?" },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 8,
        total_tokens: 18,
      },
    };

    const result = openAIResponseToAnthropic(res, "claude-3-5-sonnet-20241022");

    expect(result.id).toBe("msg_chatcmpl-abc123");
    expect(result.type).toBe("message");
    expect(result.role).toBe("assistant");
    expect(result.model).toBe("claude-3-5-sonnet-20241022");
    expect(result.stop_reason).toBe("end_turn");
    expect(result.content).toEqual([{ type: "text", text: "Hello! How can I help?" }]);
    expect(result.usage).toEqual({ input_tokens: 10, output_tokens: 8 });
  });

  it("maps finish_reason correctly", () => {
    const base: OpenAIResponse = {
      id: "msg_test",
      object: "chat.completion",
      created: 0,
      model: "gpt-4",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "x" },
          finish_reason: "stop",
        },
      ],
    };

    expect(openAIResponseToAnthropic(base, "m").stop_reason).toBe("end_turn");

    base.choices[0].finish_reason = "length";
    expect(openAIResponseToAnthropic(base, "m").stop_reason).toBe("max_tokens");

    base.choices[0].finish_reason = "tool_calls";
    expect(openAIResponseToAnthropic(base, "m").stop_reason).toBe("tool_use");

    base.choices[0].finish_reason = "content_filter";
    expect(openAIResponseToAnthropic(base, "m").stop_reason).toBeNull();
  });

  it("converts tool_calls to tool_use content blocks", () => {
    const res: OpenAIResponse = {
      id: "msg_tool",
      object: "chat.completion",
      created: 0,
      model: "gpt-4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_abc",
                type: "function",
                function: {
                  name: "get_weather",
                  arguments: '{"location":"NYC"}',
                },
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
        id: "call_abc",
        name: "get_weather",
        input: { location: "NYC" },
      },
    ]);
  });

  it("handles both text and tool_calls in same response", () => {
    const res: OpenAIResponse = {
      id: "msg_both",
      object: "chat.completion",
      created: 0,
      model: "gpt-4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "I'll check the weather.",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "weather", arguments: "{}" },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    };

    const result = openAIResponseToAnthropic(res, "m");

    expect(result.content).toHaveLength(2);
    expect(result.content[0].type).toBe("text");
    expect(result.content[1].type).toBe("tool_use");
  });

  it("preserves msg_ prefix if id already has it", () => {
    const res: OpenAIResponse = {
      id: "msg_already",
      object: "chat.completion",
      created: 0,
      model: "gpt-4",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "x" },
          finish_reason: "stop",
        },
      ],
    };

    expect(openAIResponseToAnthropic(res, "m").id).toBe("msg_already");
  });

  it("defaults usage to zeros when missing", () => {
    const res: OpenAIResponse = {
      id: "no-usage",
      object: "chat.completion",
      created: 0,
      model: "gpt-4",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "x" },
          finish_reason: "stop",
        },
      ],
    };

    expect(openAIResponseToAnthropic(res, "m").usage).toEqual({
      input_tokens: 0,
      output_tokens: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// mapToAnthropicError
// ---------------------------------------------------------------------------

describe("mapToAnthropicError", () => {
  it("maps 400 to invalid_request_error", () => {
    const result = mapToAnthropicError(400, "bad request");
    expect(result.status).toBe(400);
    expect(result.body.type).toBe("error");
    expect(result.body.error.type).toBe("invalid_request_error");
    expect(result.body.error.message).toBe("bad request");
  });

  it("maps 401 to authentication_error", () => {
    const result = mapToAnthropicError(401, "unauthorized");
    expect(result.status).toBe(401);
    expect(result.body.error.type).toBe("authentication_error");
  });

  it("maps 429 to rate_limit_error", () => {
    const result = mapToAnthropicError(429, "too many");
    expect(result.status).toBe(429);
    expect(result.body.error.type).toBe("rate_limit_error");
  });

  it("maps 502/503 to 529 (overloaded)", () => {
    const r502 = mapToAnthropicError(502, "bad gateway");
    expect(r502.status).toBe(529);
    expect(r502.body.error.type).toBe("api_error");

    const r503 = mapToAnthropicError(503, "unavailable");
    expect(r503.status).toBe(529);
    expect(r503.body.error.type).toBe("api_error");
  });

  it("maps 529 to 529 (overloaded)", () => {
    const result = mapToAnthropicError(529, "overloaded");
    expect(result.status).toBe(529);
    expect(result.body.error.type).toBe("overloaded_error");
  });

  it("maps status < 400 to 500", () => {
    // Status 200 or similar edge case should map to 500
    const result = mapToAnthropicError(200, "unexpected");
    expect(result.status).toBe(500);
  });
});

describe("openAIResponseToAnthropic — JSON parse failure", () => {
  it("handles tool call with invalid JSON arguments gracefully", () => {
    const res: OpenAIResponse = {
      id: "msg_test",
      object: "chat.completion",
      created: 0,
      model: "gpt-4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_bad",
                type: "function",
                function: {
                  name: "my_tool",
                  arguments: "not valid json {{{",
                },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    };

    const result = openAIResponseToAnthropic(res, "m");

    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("tool_use");
    // When JSON parse fails, input should fall back to {}
    expect(result.content[0].input).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Cost estimation
// ---------------------------------------------------------------------------

describe("estimateAnthropicCost", () => {
  it("estimates cost from token counts", () => {
    const cost = estimateAnthropicCost({ input_tokens: 1000, output_tokens: 500 });
    expect(cost).toBeGreaterThan(0);
    // 1000 * 0.000003 + 500 * 0.000015 = 0.003 + 0.0075 = 0.0105
    expect(cost).toBeCloseTo(0.0105, 4);
  });
});

describe("estimateOpenAICost", () => {
  it("estimates cost from token counts", () => {
    const cost = estimateOpenAICost({ prompt_tokens: 1000, completion_tokens: 500 });
    expect(cost).toBeGreaterThan(0);
    // 1000 * 0.000001 + 500 * 0.000002 = 0.001 + 0.001 = 0.002
    expect(cost).toBeCloseTo(0.002, 4);
  });
});
