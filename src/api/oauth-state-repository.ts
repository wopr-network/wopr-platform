import type { OAuthState } from "./repository-types.js";

export interface IOAuthStateRepository {
  create(data: Omit<OAuthState, "token" | "status">): Promise<OAuthState>;
  consumePending(state: string): Promise<OAuthState | null>;
  completeWithToken(state: string, token: string, userId: string): Promise<void>;
  consumeCompleted(state: string, userId: string): Promise<OAuthState | null>;
  purgeExpired(): Promise<number>;
}
