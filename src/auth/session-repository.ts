import type { SessionRecord } from "./repository-types.js";

export interface ISessionRepository {
  create(session: SessionRecord): SessionRecord;
  validate(sessionId: string): SessionRecord | null;
  revoke(sessionId: string): boolean;
  purgeExpired(): number;
  readonly size: number;
}
