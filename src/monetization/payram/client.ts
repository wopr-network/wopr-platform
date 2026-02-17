import { Payram } from "payram";

export interface PayRamConfig {
  apiKey: string;
  baseUrl: string;
}

export function createPayRamClient(config: PayRamConfig): Payram {
  return new Payram({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    config: { timeoutMs: 30_000, maxRetries: 2, retryPolicy: "safe" },
  });
}

export function loadPayRamConfig(): PayRamConfig | null {
  const apiKey = process.env.PAYRAM_API_KEY;
  const baseUrl = process.env.PAYRAM_BASE_URL;
  if (!apiKey || !baseUrl) return null;
  return { apiKey, baseUrl };
}
