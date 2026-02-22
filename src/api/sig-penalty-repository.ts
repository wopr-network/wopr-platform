import type { SigPenalty } from "./repository-types.js";

export interface ISigPenaltyRepository {
  get(ip: string, source: string): SigPenalty | null;
  recordFailure(ip: string, source: string): SigPenalty;
  clear(ip: string, source: string): void;
  purgeStale(decayMs: number): number;
}
