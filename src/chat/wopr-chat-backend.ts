import { logger } from "@wopr-network/platform-core/config/logger";
import type { IDaemonManager } from "@wopr-network/platform-core/onboarding/daemon-manager";
import type { OnboardingService } from "@wopr-network/platform-core/onboarding/onboarding-service";
import type { IChatBackend } from "./chat-backend.js";
import type { ChatEvent } from "./types.js";

/**
 * Chat backend that delegates to a live WOPR instance via OnboardingService.inject(),
 * which enforces session budgets, records usage, and uses the correct WOPR session name.
 */
export class WoprChatBackend implements IChatBackend {
  constructor(
    private readonly onboardingService: Pick<OnboardingService, "inject">,
    private readonly daemon: Pick<IDaemonManager, "isReady">,
  ) {}

  async process(sessionId: string, message: string, emit: (event: ChatEvent) => void): Promise<void> {
    if (!this.daemon.isReady()) {
      emit({ type: "error", message: "WOPR daemon is not ready" });
      emit({ type: "done" });
      return;
    }

    try {
      const response = await this.onboardingService.inject(sessionId, message, { from: "user" });
      emit({ type: "text", delta: String(response) });
    } catch (err) {
      logger.error("[chat] WoprChatBackend inject failed", { err, sessionId });
      emit({ type: "error", message: "An error occurred" });
    } finally {
      emit({ type: "done" });
    }
  }
}
