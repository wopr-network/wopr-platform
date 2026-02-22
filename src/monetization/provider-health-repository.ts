import type { ProviderHealthOverride } from "./repository-types.js";

export interface IProviderHealthRepository {
  get(adapter: string): ProviderHealthOverride | null;
  getAll(): ProviderHealthOverride[];
  markUnhealthy(adapter: string): void;
  markHealthy(adapter: string): void;
  purgeExpired(unhealthyTtlMs: number): number;
}
