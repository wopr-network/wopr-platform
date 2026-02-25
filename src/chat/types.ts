/** Events sent over SSE to the browser */
export type ChatEvent =
  | { type: "text"; delta: string }
  | { type: "tool_call"; tool: string; args: Record<string, unknown> }
  | { type: "error"; message: string }
  | { type: "done" };

/** POST /api/chat request body */
export interface ChatRequest {
  sessionId: string;
  message: string;
}

/** POST /api/chat response */
export interface ChatResponse {
  streamId: string;
}
