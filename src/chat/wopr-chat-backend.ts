import type { IDaemonManager } from "../onboarding/daemon-manager.js";
import type { IWoprClient } from "../onboarding/wopr-client.js";
import type { IChatBackend } from "./chat-backend.js";
import type { ChatEvent } from "./types.js";

/**
 * Chat backend that delegates to a live WOPR instance via IWoprClient.inject().
 */
export class WoprChatBackend implements IChatBackend {
  constructor(
    private readonly client: Pick<IWoprClient, "inject">,
    private readonly daemon: Pick<IDaemonManager, "isReady">,
  ) {}

  async process(sessionId: string, message: string, emit: (event: ChatEvent) => void): Promise<void> {
    if (!this.daemon.isReady()) {
      emit({ type: "error", message: "WOPR daemon is not ready" });
      emit({ type: "done" });
      return;
    }

    try {
      const response = await this.client.inject(sessionId, message, { from: "user" });
      emit({ type: "text", delta: response });
    } catch (err) {
      emit({ type: "error", message: err instanceof Error ? err.message : String(err) });
    }
    emit({ type: "done" });
  }
}
