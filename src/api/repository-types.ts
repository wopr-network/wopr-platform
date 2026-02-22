export type OAuthStatus = "pending" | "completed" | "expired";

export interface OAuthState {
  state: string;
  provider: string;
  userId: string;
  redirectUri: string;
  token: string | null;
  status: OAuthStatus;
  createdAt: number;
  expiresAt: number;
}

export interface SigPenalty {
  ip: string;
  source: string;
  failures: number;
  blockedUntil: number;
  updatedAt: number;
}

export interface RateLimitEntry {
  key: string;
  scope: string;
  count: number;
  windowStart: number;
}
