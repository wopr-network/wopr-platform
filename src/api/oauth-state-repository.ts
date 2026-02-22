import type { OAuthState } from "./repository-types.js";

export interface IOAuthStateRepository {
  create(data: Omit<OAuthState, "token" | "status">): OAuthState;
  consumePending(state: string): OAuthState | null;
  completeWithToken(state: string, token: string, userId: string): void;
  consumeCompleted(state: string, userId: string): OAuthState | null;
  purgeExpired(): number;
}
