import type { ChatEvent } from "./types.js";

/**
 * Interface for the chat backend that processes user messages
 * and produces ChatEvents.
 *
 * The real implementation will delegate to woprInstance.inject().
 * This stub echoes the message back for testing.
 */
export interface IChatBackend {
  /**
   * Process a user message in a session.
   * Calls `emit` for each ChatEvent produced, ending with { type: "done" }.
   */
  process(sessionId: string, message: string, emit: (event: ChatEvent) => void): Promise<void>;
}

/**
 * Stub backend for testing — echoes the message back as a text event.
 */
export class EchoChatBackend implements IChatBackend {
  async process(_sessionId: string, message: string, emit: (event: ChatEvent) => void): Promise<void> {
    if (message === "") {
      // First-visit greeting
      emit({ type: "text", delta: "Welcome to WOPR! How can I help you today?" });
    } else {
      emit({ type: "text", delta: `Echo: ${message}` });
    }
    emit({ type: "done" });
  }
}
