import type { OAuthState } from "@wopr-network/platform-core/api/repository-types";

export interface IOAuthStateRepository {
  create(data: Omit<OAuthState, "token" | "status">): Promise<OAuthState>;
  consumePending(state: string): Promise<OAuthState | null>;
  completeWithToken(state: string, token: string, userId: string): Promise<void>;
  consumeCompleted(state: string, userId: string): Promise<OAuthState | null>;
  purgeExpired(): Promise<number>;
}
