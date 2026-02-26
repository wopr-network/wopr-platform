import type { SigPenalty } from "./repository-types.js";

export interface ISigPenaltyRepository {
  get(ip: string, source: string): Promise<SigPenalty | null>;
  recordFailure(ip: string, source: string): Promise<SigPenalty>;
  clear(ip: string, source: string): Promise<void>;
  purgeStale(decayMs: number): Promise<number>;
}
