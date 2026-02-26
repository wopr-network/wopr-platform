import type { ProviderHealthOverride } from "./repository-types.js";

export interface IProviderHealthRepository {
  get(adapter: string): Promise<ProviderHealthOverride | null>;
  getAll(): Promise<ProviderHealthOverride[]>;
  markUnhealthy(adapter: string): Promise<void>;
  markHealthy(adapter: string): Promise<void>;
  purgeExpired(unhealthyTtlMs: number): Promise<number>;
}
